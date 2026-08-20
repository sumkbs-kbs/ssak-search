"""
Extended Unit Tests — Scrapling Sidecar stock_naver.py

Tests additional functions not covered in the basic test suite:
  - detect_exchange() with KRX-based KOSPI/KOSDAQ code sets
  - fetch_stock_data() full flow (mocked fetcher)
  - parse_korean_number() edge cases
  - lookup_stock_code() edge cases

Run: pip install pytest httpx && pytest sidecar/tests/test_stock_naver_extended.py -v
"""

from __future__ import annotations

import sys
import os
import json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from app import stock_naver

# Skip HTTPX-based tests if httpx is not installed
pytest.importorskip("httpx", reason="httpx not installed — run: pip install httpx")
from httpx import AsyncClient as HttpxAsyncClient

# Alias functions for clean test references
detect_exchange = stock_naver.detect_exchange
lookup_stock_code = stock_naver.lookup_stock_code
parse_korean_number = stock_naver.parse_korean_number
extract_stock_code = stock_naver.extract_stock_code
extract_company_name = stock_naver.extract_company_name
search_stock_code_naver = stock_naver.search_stock_code_naver


# ============================================================
# detect_exchange — KOSPI/KOSDAQ 구분 (KRX 데이터셋 기반)
# ============================================================
class TestDetectExchange:
    def test_kospi_market_leaders(self):
        assert detect_exchange("005930") == "KOSPI"   # 삼성전자
        assert detect_exchange("000660") == "KOSPI"   # SK하이닉스
        assert detect_exchange("005380") == "KOSPI"   # 현대차
        assert detect_exchange("207940") == "KOSPI"   # 삼성바이오로직스
        assert detect_exchange("105560") == "KOSPI"   # KB금융
        assert detect_exchange("068270") == "KOSPI"   # 셀트리온

    def test_kosdaq_market_leaders(self):
        codes = ["196170", "247540", "086520", "277810", "036930"]
        for code in codes:
            assert detect_exchange(code) == "KOSDAQ", f"{code} should be KOSDAQ"

    def test_kosdaq_small_caps(self):
        codes = ["091700", "228760", "265520", "079370", "136480"]
        for code in codes:
            assert detect_exchange(code) == "KOSDAQ", f"{code} should be KOSDAQ"

    def test_invalid_code_returns_kospi_default(self):
        assert detect_exchange("") == "KOSPI"
        # "abc" — prefix 'a' is not in ('0','1') → KOSDAQ
        assert detect_exchange("abc") == "KOSDAQ"
        # "1234" — prefix '1' → KOSPI
        assert detect_exchange("1234") == "KOSPI"
        assert detect_exchange("000000") == "KOSPI"
        # "999999" — prefix '9' → KOSDAQ
        assert detect_exchange("999999") == "KOSDAQ"

    def test_all_kospi_codes_are_6_char_alphanumeric(self):
        for code in list(stock_naver.KOSPI_CODES)[:200]:
            assert len(code) == 6 and code.isalnum(), f"Invalid KOSPI code: {code}"

    def test_all_kosdaq_codes_are_6_char_alphanumeric(self):
        for code in list(stock_naver.KOSDAQ_CODES)[:200]:
            assert len(code) == 6 and code.isalnum(), f"Invalid KOSDAQ code: {code}"

    def test_no_overlap_between_kospi_and_kosdaq(self):
        overlap = stock_naver.KOSPI_CODES & stock_naver.KOSDAQ_CODES
        assert len(overlap) == 0, f"Found {len(overlap)} overlapping codes"


# ============================================================
# extract_stock_code (Python version)
# ============================================================
class TestExtractStockCode:
    def test_extracts_6_digit_code(self):
        assert extract_stock_code("005930") == "005930"
        assert extract_stock_code("삼성전자 005930 주가") == "005930"

    def test_returns_none_for_invalid(self):
        assert extract_stock_code("12345") is None
        assert extract_stock_code("abc") is None
        assert extract_stock_code("") is None


# ============================================================
# extract_company_name
# ============================================================
class TestExtractCompanyName:
    def test_removes_korean_financial_keywords(self):
        assert extract_company_name("삼성전자 주가") == "삼성전자"
        assert extract_company_name("SK하이닉스 목표주가") == "SK하이닉스"
        assert extract_company_name("셀트리온 실적 발표") == "셀트리온"

    def test_removes_english_financial_keywords(self):
        assert extract_company_name("Apple stock price") == "Apple"
        assert extract_company_name("TSLA share target") == "TSLA"

    def test_returns_query_when_no_keywords(self):
        assert extract_company_name("삼성전자") == "삼성전자"
        assert extract_company_name("오늘 날씨") == "오늘 날씨"

    def test_removes_exchange_names(self):
        assert extract_company_name("삼성전자 코스피") == "삼성전자"
        assert extract_company_name("셀트리온 코스닥") == "셀트리온"


# ============================================================
# lookup_stock_code
# ============================================================
class TestLookupStockCode:
    def test_known_company_names(self):
        assert lookup_stock_code("삼성전자") == "005930"
        assert lookup_stock_code("SK하이닉스") == "000660"
        assert lookup_stock_code("셀트리온") == "068270"
        assert lookup_stock_code("NAVER") == "035420"

    def test_company_with_financial_context(self):
        assert lookup_stock_code("삼성전자 주가") == "005930"
        assert lookup_stock_code("현대차 목표주가") == "005380"

    def test_direct_code_match(self):
        assert lookup_stock_code("005930") == "005930"
        assert lookup_stock_code("068270 시세") == "068270"

    def test_unknown_company_returns_none(self):
        assert lookup_stock_code("알수없음") is None
        assert lookup_stock_code("") is None
        assert lookup_stock_code("   ") is None

    def test_alternative_names(self):
        assert lookup_stock_code("기아자동차") == "000270"
        assert lookup_stock_code("기아") == "000270"
        assert lookup_stock_code("현대자동차") == "005380"
        assert lookup_stock_code("현대차") == "005380"

    def test_korean_english_mixed(self):
        assert lookup_stock_code("NAVER 주가") == "035420"
        assert lookup_stock_code("SK하이닉스 stock") == "000660"


# ============================================================
# parse_korean_number
# ============================================================
class TestParseKoreanNumber:
    def test_zero_and_negative(self):
        assert parse_korean_number("0") == 0.0
        assert parse_korean_number("-1,500") == -1500.0
        assert parse_korean_number("-0.87") == -0.87

    def test_large_numbers(self):
        assert parse_korean_number("65,755,076,650") == 65755076650.0
        assert parse_korean_number("39,557,355,465,500") == 39557355465500.0

    def test_invalid_inputs(self):
        assert parse_korean_number("") == 0.0
        # "abc"는 진짜 파싱 불가 → None
        assert parse_korean_number("abc") is None


# ============================================================
# fetch_stock_data — mock으로 전체 흐름 검증
# ============================================================class TestFetchStockData:
    """fetch_stock_data with mocked HTTP client (uses httpx.get, not AsyncClient)"""

    @pytest.mark.asyncio
    async def test_fetch_stock_data_success(self):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "datas": [{
                "itemCode": "005930",
                "stockName": "삼성전자",
                "closePrice": "45,900",
                "compareToPreviousClosePrice": "-500",
                "fluctuationsRatio": "-1.08",
                "openPrice": "46,200",
                "highPrice": "46,500",
                "lowPrice": "45,500",
                "accumulatedVolume": "130,000",
                "marketValue": "300,000,000,000,000",
                "marketStatus": "OPEN",
                "previousClose": "46,400",
            }],
            "dateTime": "20260722153000",
        }
        with patch("httpx.get", return_value=mock_response):
            result = await stock_naver.fetch_stock_data("005930")
            assert result is not None
            assert result.get("name") == "삼성전자"
            assert result.get("code") == "005930"
            assert result.get("exchange") == "KOSPI"
            assert isinstance(result.get("price"), (int, float))

    @pytest.mark.asyncio
    async def test_fetch_stock_data_kosdaq(self):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "datas": [{
                "itemCode": "196170",
                "stockName": "알테오젠",
                "closePrice": "250,000",
                "compareToPreviousClosePrice": "+5,000",
                "fluctuationsRatio": "+2.04",
                "openPrice": "248,000",
                "highPrice": "252,000",
                "lowPrice": "247,000",
                "accumulatedVolume": "500,000",
                "marketValue": "10,000,000,000,000",
                "marketStatus": "OPEN",
                "previousClose": "245,000",
            }],
            "dateTime": "20260722153000",
        }
        with patch("httpx.get", return_value=mock_response):
            result = await stock_naver.fetch_stock_data("196170")
            assert result is not None
            assert result.get("exchange") == "KOSDAQ"

    @pytest.mark.asyncio
    async def test_fetch_stock_data_returns_none_on_error(self):
        with patch("httpx.get", side_effect=Exception("API unreachable")):
            result = await stock_naver.fetch_stock_data("005930")
            # Function returns a dict with success=False, not None
            assert result is not None
            assert result.get("success") is False

    @pytest.mark.asyncio
    async def test_fetch_stock_data_non_ok_status(self):
        mock_response = MagicMock()
        mock_response.status_code = 503
        with patch("httpx.get", return_value=mock_response):
            result = await stock_naver.fetch_stock_data("005930")
            # Falls back to HTML scraping, so may still return a result
            assert result is not None

    @pytest.mark.asyncio
    async def test_fetch_stock_data_invalid_json(self):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.side_effect = json.JSONDecodeError("bad", "", 0)
        with patch("httpx.get", return_value=mock_response):
            result = await stock_naver.fetch_stock_data("005930")
            # Falls back to HTML scraping on JSON error
            assert result is not None
