"""
Unit Tests — Scrapling Sidecar stock_naver.py

Tests the core parsing/lookup functions (no network required):
  - parse_korean_number()
  - extract_stock_code()
  - extract_company_name()
  - lookup_stock_code()
  - detect_exchange()

Run: pytest sidecar/tests/test_stock_naver.py -v
"""

from __future__ import annotations

import sys
import os

# Add the sidecar directory to Python path so we can import app.stock_naver
# (needed for relative imports in stock_naver.py like 'from .scraper import ...')
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from app import stock_naver

# Alias functions for clean test references
parse_korean_number = stock_naver.parse_korean_number
extract_stock_code = stock_naver.extract_stock_code
extract_company_name = stock_naver.extract_company_name
lookup_stock_code = stock_naver.lookup_stock_code
detect_exchange = stock_naver.detect_exchange


# ============================================================
# parse_korean_number
# ============================================================

class TestParseKoreanNumber:
    """parse_korean_number — 한국어 숫자 포맷 파싱"""

    def test_plain_number(self):
        """일반 숫자 (콤마 포함)"""
        assert parse_korean_number("170,100") == 170100
        assert parse_korean_number("1,000") == 1000
        assert parse_korean_number("0") == 0

    def test_number_without_commas(self):
        """콤마 없는 숫자"""
        assert parse_korean_number("170100") == 170100
        assert parse_korean_number("50000") == 50000

    def test_man_unit(self):
        """만 단위"""
        assert parse_korean_number("1.23만") == 12300
        assert parse_korean_number("10만") == 100000
        assert parse_korean_number("0.5만") == 5000

    def test_eok_unit(self):
        """억 단위"""
        assert parse_korean_number("1억") == 100_000_000
        assert parse_korean_number("12.5억") == 1_250_000_000
        assert parse_korean_number("0.1억") == 10_000_000

    def test_jo_unit(self):
        """조 단위"""
        assert parse_korean_number("1조") == 1_000_000_000_000
        assert parse_korean_number("39.5조") == 39_500_000_000_000
        assert parse_korean_number("0.1조") == 100_000_000_000

    def test_trailing_whitespace(self):
        """앞뒤 공백 처리"""
        assert parse_korean_number("  170,100  ") == 170100
        assert parse_korean_number("\t1,000\n") == 1000

    def test_spaces_in_numbers(self):
        """숫자 내 공백 제거"""
        assert parse_korean_number("1 70,100") == 170100
        assert parse_korean_number("5 0 0 0 0") == 50000

    def test_empty_input(self):
        """빈 문자열 또는 None"""
        assert parse_korean_number("") == 0.0
        assert parse_korean_number(None) is None  # type: ignore[arg-type]

    def test_invalid_input(self):
        """파싱 불가능한 입력"""
        assert parse_korean_number("abc") is None
        assert parse_korean_number("가나다") is None
        assert parse_korean_number("--") is None

    def test_korean_mixed_number(self):
        """한글이 섞인 숫자 문자열"""
        # "170,100원" 형태 — replace가 ","만 제거하므로 "원"은 남아서 int() 실패
        # 하지만 strip으로 "원"이 제거되지 않으므로 파싱 실패
        assert parse_korean_number("170,100원") is None

    def test_negative_number(self):
        """음수"""
        assert parse_korean_number("-1,500") == -1500
        assert parse_korean_number("-100") == -100

    def test_large_number(self):
        """큰 숫자"""
        assert parse_korean_number("39,557,355,465,500") == 39557355465500
        assert parse_korean_number("1,000,000,000,000") == 1000000000000

    def test_zero_values(self):
        """0 관련 입력"""
        assert parse_korean_number("0") == 0.0
        assert parse_korean_number("0원") is None
        assert parse_korean_number("0.0") == 0.0


# ============================================================
# extract_stock_code
# ============================================================

class TestExtractStockCode:
    """extract_stock_code — 쿼리에서 6자리 종목코드 추출"""

    def test_direct_code(self):
        """직접 입력한 6자리 코드"""
        assert extract_stock_code("005930") == "005930"
        assert extract_stock_code("068270") == "068270"

    def test_code_with_query(self):
        """쿼리에 포함된 코드"""
        assert extract_stock_code("005930 삼성전자 주가") == "005930"
        assert extract_stock_code("068270 셀트리온") == "068270"

    def test_code_with_suffix(self):
        """코드 뒤에 추가 텍스트
        NOTE: Python3 \\w가 한글(Unicode letter)까지 포함하므로 \\b가 숫자-한글 경계에서
        매치되지 않아 005930입니다에서 005930 추출 실패. 공백 뒤의 코드는 정상 추출."""
        assert extract_stock_code("005930입니다") is None  # 한글 붙어있으면 \\b 미매치
        assert extract_stock_code("code 068270 ") == "068270"  # 공백 뒤는 정상

    def test_no_code(self):
        """코드가 없는 쿼리"""
        assert extract_stock_code("삼성전자 주가") is None
        assert extract_stock_code("hello") is None
        assert extract_stock_code("") is None

    def test_invalid_code_length(self):
        """5자리 또는 7자리 숫자는 코드가 아님"""
        assert extract_stock_code("12345") is None  # 5자리
        assert extract_stock_code("1234567") is None  # 7자리

    def test_multiple_codes(self):
        """여러 코드가 있으면 첫 번째 반환"""
        result = extract_stock_code("005930 068270")
        assert result == "005930"

    def test_code_with_hyphen(self):
        """하이픈으로 연결된 숫자는 취급 안 함"""
        assert extract_stock_code("123-456") is None


# ============================================================
# extract_company_name
# ============================================================

class TestExtractCompanyName:
    """extract_company_name — 쿼리에서 금융 키워드 제거"""

    def test_simple_stock_query(self):
        """'주가' 키워드 제거"""
        result = extract_company_name("삼성전자 주가")
        assert "주가" not in result
        assert "삼성전자" in result

    def test_multiple_keywords(self):
        """여러 금융 키워드 한 번에 제거"""
        result = extract_company_name("삼성전자 목표주가 투자의견")
        assert result.strip() == "삼성전자"

    def test_english_keywords(self):
        """영문 키워드 제거 (NAVER는 회사명이므로 보존)"""
        assert extract_company_name("Samsung stock price") == "Samsung"
        # 'NAVER'는 더 이상 키워드로 제거되지 않음 (회사명 보존)
        assert extract_company_name("NAVER share price") == "NAVER"
        # 'target'도 키워드로 제거됨
        assert extract_company_name("Samsung target price") == "Samsung"

    def test_korean_stock_terms(self):
        """한글 금융 용어 제거"""
        assert extract_company_name("한화에어로스페이스 PER PBR") == "한화에어로스페이스"
        assert extract_company_name("셀트리온 시가총액 거래량") == "셀트리온"

    def test_finance_naver_keywords(self):
        """네이버증권 키워드 제거"""
        result = extract_company_name("네이버증권 삼성전자")
        assert "네이버증권" not in result
        assert "삼성전자" in result.strip()

    def test_whitespace_handling(self):
        """연속 공백 정리"""
        result = extract_company_name("삼성전자   주가   목표주가")
        assert "  " not in result
        assert result.strip() == "삼성전자"

    def test_no_keywords(self):
        """금융 키워드 없음 — 원본 유지"""
        assert extract_company_name("삼성전자") == "삼성전자"
        assert extract_company_name("기아 자동차") == "기아 자동차"

    def test_empty_input(self):
        """빈 입력"""
        assert extract_company_name("") == ""
        assert extract_company_name("   ") == ""

    def test_only_keywords(self):
        """키워드만 있는 경우"""
        result = extract_company_name("주가 주식 시세")
        assert result == ""

    def test_mixed_case_english(self):
        """대소문자 혼합 영문 키워드"""
        assert extract_company_name("SAMSUNG Stock") == "SAMSUNG"
        assert extract_company_name("Apple Finance Chart") == "Apple"


# ============================================================
# lookup_stock_code
# ============================================================

class TestLookupStockCode:
    """lookup_stock_code — 종목코드 조회 통합"""

    def test_direct_code(self):
        """직접 코드 입력"""
        assert lookup_stock_code("005930") == "005930"
        assert lookup_stock_code("068270") == "068270"

    def test_company_name(self):
        """회사명으로 조회"""
        assert lookup_stock_code("삼성전자") == "005930"
        assert lookup_stock_code("SK하이닉스") == "000660"
        assert lookup_stock_code("셀트리온") == "068270"

    def test_company_with_stock_query(self):
        """회사명 + 금융 키워드"""
        assert lookup_stock_code("삼성전자 주가") == "005930"
        assert lookup_stock_code("셀트리온 목표주가") == "068270"
        assert lookup_stock_code("현대차 PER") == "005380"
        assert lookup_stock_code("NAVER 시가총액") == "035420"

    def test_company_name_in_middle(self):
        """회사명이 쿼리 중간에"""
        assert lookup_stock_code("오늘 기아 주가 분석") == "000270"
        assert lookup_stock_code("LG화학 배당") == "051910"

    def test_alternative_names(self):
        """여러 이름 매핑"""
        assert lookup_stock_code("현대자동차") == "005380"  # 현대차 == 현대자동차
        assert lookup_stock_code("포스코") == "005490"
        assert lookup_stock_code("네이버") == "035420"

    def test_unknown_company(self):
        """알 수 없는 회사"""
        assert lookup_stock_code("알수없는회사") is None
        assert lookup_stock_code("abc") is None

    def test_empty_query(self):
        """빈 쿼리"""
        assert lookup_stock_code("") is None
        assert lookup_stock_code("   ") is None

    def test_code_with_trailing_text(self):
        """코드 + 추가 텍스트"""
        assert lookup_stock_code("005930 주가") == "005930"
        assert lookup_stock_code("068270 테스트") == "068270"

    def test_partial_name_match(self):
        """이름 일부 포함 — map의 키가 포함되면 매칭"""
        # "한화에어로스페이스"를 정확히 포함하는 쿼리
        assert lookup_stock_code("한화에어로스페이스") == "012450"
        # "한화"만 있으면 "한화" (000880)가 먼저 매칭됨 (for문 순서)
        assert lookup_stock_code("한화") == "000880"


# ============================================================
# detect_exchange
# ============================================================

class TestDetectExchange:
    """detect_exchange — KOSPI/KOSDAQ 구분 (실제 KRX 상장 목록 기반)"""

    def test_kospi_codes(self):
        """KOSPI 종목 — 실제 KOSPI_CODES set에서 조회"""
        assert detect_exchange("005930") == "KOSPI"  # 삼성전자
        assert detect_exchange("000660") == "KOSPI"  # SK하이닉스
        assert detect_exchange("105560") == "KOSPI"  # KB금융
        assert detect_exchange("068270") == "KOSPI"  # 셀트리온 (KOSPI 이전 완료)
        assert detect_exchange("035420") == "KOSPI"  # NAVER
        assert detect_exchange("005380") == "KOSPI"  # 현대차
        assert detect_exchange("207940") == "KOSPI"  # 삼성바이오로직스

    def test_kosdaq_codes(self):
        """KOSDAQ 종목 — 실제 KOSDAQ_CODES set에서 조회"""
        assert detect_exchange("247540") == "KOSDAQ"  # 솔루엠
        assert detect_exchange("196170") == "KOSDAQ"  # 알테오젠
        assert detect_exchange("086520") == "KOSDAQ"  # 에코프로
        assert detect_exchange("240810") == "KOSDAQ"  # 원익IPS

    def test_unknown_code_prefix_fallback(self):
        """알 수 없는 코드 → prefix 휴리스틱 폴백"""
        # 0/1 시작 → KOSPI
        assert detect_exchange("000000") == "KOSPI"
        assert detect_exchange("100000") == "KOSPI"
        # 2~9 시작 → KOSDAQ
        assert detect_exchange("200000") == "KOSDAQ"
        assert detect_exchange("900000") == "KOSDAQ"

    def test_non_numeric(self):
        """숫자가 아닌 코드 — prefix 폴백"""
        assert detect_exchange("") == "KOSPI"    # 빈 문자열 → 기본 KOSPI
        assert detect_exchange("abc") == "KOSDAQ"  # 'abc'는 ('0','1')로 시작 안 함
        assert detect_exchange("  ") == "KOSPI"    # 공백도 strip 후 빈 문자열 → KOSPI

    def test_etf_and_etn(self):
        """ETF/ETN 코드도 실제 시장 분류 확인"""
        assert detect_exchange("069500") == "KOSPI"  # KODEX 200 (KOSPI 상장 ETF)
        assert detect_exchange("122630") == "KOSPI"  # KODEX 레버리지
        assert detect_exchange("153130") == "KOSPI"  # TIGER 200
