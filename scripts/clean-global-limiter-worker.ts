/**
 * 방안 B 마이그레이션 클리너 워커 (2026-08-14).
 *
 * staging/production 이 환경별 DO 인스턴스(rateLimiterInstanceName — 'staging'/'production')로
 * 분리된 뒤에도, 분리 이전의 공유 인스턴스 **'global'** 이 DO 스토리지에 남아 있을 수 있다.
 * 문제는 스토리지 자체가 아니라 **잔존 alarm**: 열린 서킷이 있으면 scheduleCircuitProbe()가
 * 60s 주기 alarm 을 계속 (재)스케줄하고, alarm 은 RPC 없이도 DO 를 깨워 업스트림
 * robots.txt 프로브(egress 트래픽)를 쏜다. 'global' 인스턴스를 참조하는 워커가 더는
 * 없으므로 이 프로브는 영원히 멈추지 않는다.
 *
 * 이 워커는 ssak-do-worker 의 RateLimiterDO 클래스를 script_name 으로 원격 바인딩해
 * (wrangler.probe-limiter.jsonc), 구 'global' 인스턴스에 reset() RPC 를 호출한다 —
 * reset() 은 상태 + alarm 을 모두 지운다. 클리너가 "정리 대상이 실제로 존재했는지"
 * 확인할 수 있도록 reset 전후로 getAllHealth()/getAlarmInfo() 를 대조한다.
 *
 * 배포/실행/철거는 scripts/clean-global-limiter.sh 가 담당한다.
 * 수동 호출:  GET https://clean-global-limiter.<subdomain>.workers.dev/?instance=global&mode=status
 *             GET .../?instance=global&mode=reset
 */
export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    try {
      return await handle(request, env)
    } catch (err) {
      return json({ error: String(err) }, 500)
    }
  },
}

/** 클리너가 호출하는 RateLimiterDO RPC 의 부분집합. */
interface LimiterStub {
  getAllHealth(): Promise<Record<string, { tripped?: boolean }>>
  getAlarmInfo(): Promise<{ pendingAlarmAt: number | null }>
  reset(): Promise<void>
}

interface ProbeEnv {
  RATE_LIMITER?: {
    idFromName(name: string): unknown
    get(id: unknown): LimiterStub
  }
}

export async function handle(request: Request, env: ProbeEnv): Promise<Response> {
  const url = new URL(request.url)
  const instance = url.searchParams.get('instance') ?? 'global'
  const mode = url.searchParams.get('mode') ?? 'status'

  if (!env.RATE_LIMITER) {
    return json({ error: 'RATE_LIMITER binding missing — configure wrangler.probe-limiter.jsonc' }, 500)
  }

  // 구 공유 인스턴스를 **리터럴**로 지목한다 — rateLimiterInstanceName()은 빌드
  // 컨텍스트에 따라 'global'로 폴백하지만, 마이그레이션 클리너의 의도는 명시적이어야 한다.
  const id = env.RATE_LIMITER.idFromName(instance)
  const stub = env.RATE_LIMITER.get(id)

  const before = await summarize(stub)

  if (mode === 'reset') {
    await stub.reset()
    const after = await summarize(stub)
    return json({
      instance,
      mode: 'reset',
      before,
      after,
      clean: after.hosts === 0 && !after.alarmPending,
    })
  }

  return json({
    instance,
    mode: 'status',
    before,
    clean: before.hosts === 0 && !before.alarmPending,
  })
}

async function summarize(stub: LimiterStub) {
  const health = await stub.getAllHealth()
  const alarm = await stub.getAlarmInfo()
  const hosts = Object.keys(health)
  return {
    hosts: hosts.length,
    openCircuits: hosts.filter((h) => health[h]?.tripped === true).length,
    hostsList: hosts,
    alarmPending: alarm.pendingAlarmAt !== null,
    pendingAlarmAt: alarm.pendingAlarmAt,
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
