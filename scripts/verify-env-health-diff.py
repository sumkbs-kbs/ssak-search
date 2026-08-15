#!/usr/bin/env python3
"""방안 B 헬스 동치 해석 — 두 /api/health JSON 의 backends status 비교 (2026-08-14).

verify-env-equivalence.sh 의 [2/4] 헬스 동치 항목이 사용하는 순수 비교 헬퍼.
DO 인스턴스가 환경별로 분리된 뒤 (방안 B) 서킷 상태는 환경마다 독립적으로
누적되므로, 헬스 status 차이는 더 이상 코드 동치와 직결되지 않는다:

  - 한쪽만 추적 중인 호스트   → INFO (트래픽 누적 차이 — 캐시 히트 시 백엔드
                                 fetch 없음 → 미추적)
  - degraded vs operational   → INFO (시점·누적 차이)
  - 한쪽만 down               → WARN (해당 환경 DO 서킷만 트립 — 런타임 상태,
                                 코드 차이가 아님. 동치 실패로 보지 않는다)
  - 양쪽 동일                  → OK
  - JSON 파싱 불가             → ERROR (exit 1 — 비교 자체 불가)

출력: 한 줄 — 'OK' | 'INFO: ...' | 'WARN: ...' | 'ERROR: ...'
exit: 0 (OK/INFO/WARN) · 1 (ERROR) · 2 (usage)
"""
import json
import sys


def compare(a, b):
    """a, b 는 /api/health 파싱 결과. (warns, info) 튜플 반환 — 모두 문자열 목록."""
    ba, bb = a.get('backends', {}), b.get('backends', {})
    warns, info = [], []
    for host in sorted(set(ba) | set(bb)):
        sa = ba.get(host, {}).get('status')
        sb = bb.get(host, {}).get('status')
        if sa is None or sb is None:
            info.append(f'{host}: {sa or "미추적"} vs {sb or "미추적"}')
            continue
        down_a, down_b = sa == 'down', sb == 'down'
        if down_a != down_b:
            # 방안 B: 한쪽 DO 서킷만 트립된 환경별 런타임 상태 — 동치 실패가 아님.
            warns.append(f'{host}: {sa} vs {sb}')
        elif sa != sb:
            info.append(f'{host}: {sa} vs {sb}')
    return warns, info


def main():
    if len(sys.argv) != 3:
        print('usage: verify-env-health-diff.py <healthA.json> <healthB.json>', file=sys.stderr)
        return 2
    try:
        with open(sys.argv[1], encoding='utf-8') as f:
            a = json.load(f)
        with open(sys.argv[2], encoding='utf-8') as f:
            b = json.load(f)
    except Exception as e:  # noqa: BLE001 — 비교 불가 사유를 그대로 출력
        print(f'ERROR: {e}')
        return 1

    warns, info = compare(a, b)
    if warns:
        print('WARN: ' + '; '.join(warns))
    elif info:
        print('INFO: ' + '; '.join(info))
    else:
        print('OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
