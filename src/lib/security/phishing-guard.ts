/**
 * Phishing / SEO-poisoning guard.
 *
 * Modeled on the "chameleon" cloaked SEO-poisoning campaign against financial
 * customers (boannews 145457 / Fortra FIRE): typosquatted domains ranked at
 * the top of Google/Bing SERPs that serve 404 to scanners and cloned login
 * portals to search-referrer traffic, heavily abusing shared second-level
 * suffix registrations (.ph.com, .gr.com — anyone can register
 * "brandname.ph.com" and it reads like a brand domain).
 *
 * ssak-search inherits whatever the scraped SERPs rank, so these defenses run
 * at every layer where a URL flows through us:
 *   - main pipeline: applyFilters() drops block-risk results
 *   - fast agent path: hits are screened the same way
 *   - extractor: redirect-origin mismatch + the 404-to-scanners cloaking
 *     signature are surfaced as security warnings
 *
 * Design constraints:
 *   - PURE local heuristics, no external feed dependency (no lookup latency,
 *     no availability coupling). Deliberately conservative: 'block' only for
 *     hostname-claims-brand-but-not-official patterns where the false-positive
 *     surface is tiny; everything softer is 'warn' and stays visible to the
 *     agent with the reason attached.
 */

export type PhishingRisk = 'block' | 'warn' | 'clean'

export interface PhishingAssessment {
  risk: PhishingRisk
  /** Machine-readable reason codes, e.g. BRAND_IMPERSONATION */
  codes: string[]
  detail: string
}

const CLEAN: PhishingAssessment = { risk: 'clean', codes: [], detail: '' }

/**
 * Shared commercial second-level suffixes ("co.cc-style"): the registry sells
 * names UNDER these, so "kbstar.ph.com" is a subdomain of ph.com — the
 * user-readable "site name" is not a registrable domain at all.
 */
const SHARED_SECOND_LEVEL_SUFFIXES = new Set([
  'ph.com',
  'gr.com',
  'jp.com',
  'ru.com',
  'uk.com',
  'de.com',
  'eu.com',
  'kr.com',
  'us.com',
  'cn.com',
  'za.com',
  'br.com',
  'ar.com',
  'in.com',
  'co.com',
  'net.com',
  'web.com',
  'online.com',
])

/**
 * Finance brands with distinctive tokens only (≥5 chars, low dictionary
 * collision — 'kb'/'hana'/'toss'/'chase' are real words and would
 * false-positive). Korean aliases matter for TITLE corroboration (cloaked
 * pages self-brand in Korean: "KB스타 인증센터"); hostnames can never contain
 * them literally (punycode), so they never widen hostname matching.
 * Attack surface per the campaign: Korean finance first, global payment second.
 */
const FINANCE_BRANDS: Array<{ tokens: string[]; official: string[] }> = [
  { tokens: ['kbstar', 'kb스타', '국민은행'], official: ['kbstar.com', 'kbfg.com', 'kbbank.com', 'kb.co.kr'] },
  { tokens: ['shinhan', '신한은행', '신한카드'], official: ['shinhan.com', 'shinhancard.com', 'shinhansec.com'] },
  { tokens: ['wooribank', '우리은행'], official: ['wooribank.com', 'woorifg.com'] },
  { tokens: ['hanabank', '하나은행'], official: ['hanabank.com', 'hana.co.kr'] },
  { tokens: ['nonghyup', 'nhbank', '농협은행'], official: ['nonghyup.com', 'nhbank.com', 'nhamc.co.kr'] },
  { tokens: ['kakaobank', '카카오뱅크'], official: ['kakaobank.com'] },
  { tokens: ['kakaopay'], official: ['kakaopay.com', 'kakaopay.co.kr'] },
  { tokens: ['tossbank', '토스뱅크'], official: ['tossbank.com', 'toss.co.kr'] },
  { tokens: ['payco'], official: ['payco.com', 'pay.co.kr'] },
  { tokens: ['kiwoom'], official: ['kiwoom.com'] },
  { tokens: ['miraeasset'], official: ['miraeasset.com', 'miraeasset.co.kr'] },
  { tokens: ['samsungcard', '삼성카드'], official: ['samsungcard.com', 'samsung.com'] },
  { tokens: ['hyundaicard', '현대카드'], official: ['hyundaicard.com'] },
  { tokens: ['lottecard', '롯데카드'], official: ['lottecard.com', 'lotte.co.kr'] },
  { tokens: ['paypal'], official: ['paypal.com'] },
  { tokens: ['wellsfargo'], official: ['wellsfargo.com'] },
  { tokens: ['citibank'], official: ['citibank.com', 'citi.com'] },
  { tokens: ['binance'], official: ['binance.com'] },
  { tokens: ['coinbase'], official: ['coinbase.com'] },
  { tokens: ['revolut'], official: ['revolut.com'] },
  { tokens: ['hsbc'], official: ['hsbc.com', 'hsbc.co.kr'] },
  { tokens: ['santander'], official: ['santander.com', 'santander.co.uk'] },
]

/** Labels commonly glued onto brand tokens by phishing kits. */
const BRAND_DECORATIONS = [
  'login',
  'secure',
  'security',
  'auth',
  'verify',
  'bank',
  'banking',
  'card',
  'pay',
  'direct',
  'online',
  'mobile',
  'm',
  'www',
  'itp',
  'ibs',
]

const SUSPICIOUS_TLDS = new Set([
  'tk',
  'ml',
  'ga',
  'cf',
  'gq',
  'xyz',
  'top',
  'click',
  'work',
  'link',
  'rest',
  'live',
  'quest',
  'mom',
  'lol',
])

const URL_SHORTENERS = new Set([
  'bit.ly',
  'tinyurl.com',
  'is.gd',
  'cutt.ly',
  'ow.ly',
  't.co',
  'goo.gl',
  'shorturl.at',
  'rebrand.ly',
  'tiny.cc',
])

const LOGIN_INTENT_RE = /(?:login|log-in|signin|sign-in|auth|verify|secure|계정|로그인|인증)/i

/**
 * Registrable domain, shared-suffix aware: for kbstar.ph.com the registrable
 * domain is ph.com (so anything claiming the "kbstar" part is squatting a
 * name inside someone else's registry), while for a.b.kbstar.com it is
 * kbstar.com.
 */
export function registrableDomain(hostname: string): string {
  const labels = hostname.split('.')
  if (labels.length <= 2) return hostname
  const lastTwo = labels.slice(-2).join('.')
  if (SHARED_SECOND_LEVEL_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return lastTwo // the shared suffix itself IS the registry
  }
  return lastTwo
}

function stripToalnum(label: string): string {
  return label.replace(/[^a-z0-9]/g, '')
}

/** True when a hostname label claims a brand identity (exact or decorated). */
function labelClaimsBrand(label: string, token: string): boolean {
  const s = stripToalnum(label)
  if (s === token) return true
  for (const deco of BRAND_DECORATIONS) {
    if (s === token + deco || s === deco + token) return true
  }
  return false
}

function isOfficialHost(hostname: string, official: string[]): boolean {
  return official.some((d) => hostname === d || hostname.endsWith(`.${d}`))
}

/**
 * Assess a result URL. `title` participates in intent detection: brand tokens
 * in the title raise confidence that a decorated hostname is impersonation
 * rather than coincidence.
 */
export function assessUrlRisk(rawUrl: string, opts: { title?: string } = {}): PhishingAssessment {
  let host: string
  let pathname: string
  let protocol: string
  try {
    const u = new URL(rawUrl)
    host = u.hostname.toLowerCase()
    pathname = u.pathname + u.search
    protocol = u.protocol
  } catch {
    return CLEAN // malformed URLs never reach fetchers anyway (SSRF guard)
  }

  const labels = host.split('.')
  const codes: string[] = []
  const details: string[] = []

  // Punycode hosts: confusable-script homoglyphs are the classic brand trick.
  // Legit IDN sites exist, so this is warn-level on its own.
  if (labels.some((l) => l.startsWith('xn--'))) {
    codes.push('IDN_PUNYCODE_HOST')
    details.push('hostname uses punycode (possible homoglyph brand imitation)')
  }

  // Finance brand impersonation — the block-level pattern.
  for (const brand of FINANCE_BRANDS) {
    const claimed = labels.some((label) => brand.tokens.some((t) => labelClaimsBrand(label, t)))
    if (!claimed) continue
    if (isOfficialHost(host, brand.official)) return CLEAN

    // Claimed identity on a non-official host. On a shared suffix
    // (kbstar.ph.com) or any non-official registrable, this is the campaign's
    // exact fingerprint.
    const reg = registrableDomain(host)
    if (brand.official.includes(reg)) {
      // e.g. login.kbstar.com — official registrable, fine
      return CLEAN
    }
    codes.push('BRAND_IMPERSONATION')
    details.push(`hostname claims "${brand.tokens[0]}" but is not an official domain (${reg})`)
    break
  }

  // Shared-suffix registration without a brand claim: the user-readable name
  // is still not a real registrable domain — warn.
  const lastTwo = labels.slice(-2).join('.')
  if (labels.length >= 3 && SHARED_SECOND_LEVEL_SUFFIXES.has(lastTwo) && !codes.includes('BRAND_IMPERSONATION')) {
    codes.push('SHARED_SUFFIX_HOST')
    details.push(`"${lastTwo}" is a shared registry — the site name inside it is not a registrable domain`)
  }

  // Shorteners hide the destination.
  if (URL_SHORTENERS.has(registrableDomain(host)) || URL_SHORTENERS.has(host)) {
    codes.push('URL_SHORTENER')
    details.push('shortened URL — destination is not visible')
  }

  // Login intent on a suspicious host shape.
  const tld = labels[labels.length - 1]
  const suspiciousShape = SUSPICIOUS_TLDS.has(tld) || codes.includes('SHARED_SUFFIX_HOST') || protocol === 'http:'
  if (LOGIN_INTENT_RE.test(pathname) && suspiciousShape) {
    codes.push('LOGIN_ON_SUSPICIOUS_HOST')
    details.push('login/auth path on a suspicious host shape')
  }

  if (codes.length === 0) return CLEAN

  // Title corroboration: cloaked pages brand themselves in the title
  // ("KB스타 인증센터" on kbstar.ph.com). A finance brand token in the title
  // upgrades IDN/shared-suffix warnings to a block.
  const titleLower = opts.title?.toLowerCase() ?? ''
  const titleClaimsBrand = FINANCE_BRANDS.some((b) => b.tokens.some((t) => titleLower.includes(t)))
  const escalated = titleClaimsBrand && (codes.includes('SHARED_SUFFIX_HOST') || codes.includes('IDN_PUNYCODE_HOST'))
  if (escalated) {
    codes.push('BRAND_IMPERSONATION_IN_TITLE')
    details.push('result title claims a finance brand the host does not own')
  }

  const risk: PhishingRisk = codes.includes('BRAND_IMPERSONATION') || escalated ? 'block' : 'warn'
  return { risk, codes, detail: details.join('; ') }
}

/** Agent-facing warning payload attached to surviving (warn-level) results. */
export interface SecurityWarning {
  code: string
  detail: string
}

export function toSecurityWarning(a: PhishingAssessment): SecurityWarning | undefined {
  if (a.risk === 'clean') return undefined
  return { code: a.codes.join('+'), detail: a.detail }
}
