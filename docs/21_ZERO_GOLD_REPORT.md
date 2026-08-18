# zero-gold 자동 분류 리포트

> 생성: 2026-08-17T12:37:51.673Z · 아티팩트: eval/results/chunk-0-100.json, eval/results/chunk-100-200.json, eval/results/chunk-200-300.json, eval/results/chunk-300-400.json, eval/results/chunk-400-500.json, eval/results/chunk-500-600.json
> 규칙: probe-p1-zero/S54 동일 (computeNdcg 실시간 재계산, median-of-6)

## 요약

| 항목 | 값 |
|---|---|
| 평가 쿼리 | 600 |
| **zero-gold (NDCG=0)** | **160 (26.7%)** |
| COVERAGE+EMPTY (커버리지) | 160 (100.0% of zero) |

## 원인 (kind) 분류

| kind | 건수 | 비율 | 의미 |
|---|---|---|---|
| COVERAGE | 160 | 100.0% | gold 도메인이 풀에 전무 |

## 언어별

| 언어 | zero | 비율 | coverage | ranking | mixed |
|---|---|---|---|---|---|
| en | 124/383 | 32% | 124 | 0 | 0 |
| zh | 15/72 | 21% | 15 | 0 | 0 |
| kr | 11/85 | 13% | 11 | 0 | 0 |
| ja | 10/60 | 17% | 10 | 0 | 0 |

## 타입 태그별

| 태그 | zero | 비율 | coverage | ranking | mixed |
|---|---|---|---|---|---|
| general | 90/139 | 65% | 90 | 0 | 0 |
| news | 28/125 | 22% | 28 | 0 | 0 |
| technical | 27/163 | 17% | 27 | 0 | 0 |
| comparison | 9/48 | 19% | 9 | 0 | 0 |
| factual | 8/98 | 8% | 8 | 0 | 0 |
| financial | 4/50 | 8% | 4 | 0 | 0 |
| academic | 3/34 | 9% | 3 | 0 | 0 |

## gold 도메인별 (COVERAGE/EMPTY 쿼리)

| gold 도메인 | zero 쿼리 수 | 쿼리 id |
|---|---|---|
| healthline.com | 38 | en-general-06, en-general-07, en-general-08, en-general-09, en-general-10, en-general-11, en-general-12, en-general-13, en-general-14, en-general-15, en-general-17, en-general-18, en-general-19, en-health-01, en-health-02, en-health-03, en-health-04, en-health-06, en-health-07, en-health-08, en-health-09, en-health-10, en-health-11, en-health-12, en-health-13, en-health-14, en-health-15, en-health-16, en-health-17, en-health-18, en-health-19, en-health-20, en-health-21, en-health-22, en-health-23, en-health-24, en-health-25, en-general-23 |
| webmd.com | 29 | en-general-06, en-general-07, en-general-08, en-general-09, en-general-10, en-general-11, en-general-12, en-general-13, en-general-14, en-general-15, en-general-17, en-general-18, en-general-19, en-health-01, en-health-02, en-health-03, en-health-06, en-health-07, en-health-08, en-health-09, en-health-11, en-health-12, en-health-14, en-health-16, en-health-18, en-health-20, en-health-22, en-health-23, en-health-25 |
| reuters.com | 24 | en-news-01, en-news-03, en-news-07, en-news-09, en-news-10, ca-01, ca-03, ca-04, ca-05, ts-03, en-news-12, en-news-13, en-news-15, en-news-19, en-news-23, en-news-26, en-news-28, en-news-31, en-news-32, en-news-34, en-news-37, ts-09, en-news-48, en-stock-29 |
| nytimes.com | 24 | en-news-19, en-news-23, en-news-26, en-news-28, en-news-31, en-news-32, en-news-34, en-news-37, en-general-06, en-general-07, en-general-08, en-general-09, en-general-10, en-general-11, en-general-12, en-general-13, en-general-14, en-general-15, en-general-17, en-general-18, en-general-19, ts-09, en-news-48, en-general-30 |
| wikihow.com | 18 | en-general-06, en-general-07, en-general-08, en-general-09, en-general-10, en-general-11, en-general-12, en-general-13, en-general-14, en-general-15, en-general-17, en-general-18, en-general-19, en-general-22, en-general-23, en-general-28, en-general-32, en-general-34 |
| theverge.com | 17 | en-news-03, en-news-09, ca-01, ts-03, ts-04, adv-05, en-news-19, en-news-23, en-news-26, en-news-28, en-news-31, en-news-32, en-news-34, en-news-37, ts-09, en-general-30, en-general-33 |
| reddit.com | 14 | en-general-06, en-general-07, en-general-08, en-general-09, en-general-10, en-general-11, en-general-12, en-general-13, en-general-14, en-general-15, en-general-17, en-general-18, en-general-19, cmp-20 |
| mayoclinic.org | 14 | en-general-19, en-health-02, en-health-04, en-health-05, en-health-06, en-health-08, en-health-09, en-health-13, en-health-14, en-health-15, en-health-17, en-health-21, en-health-22, en-health-24 |
| quora.com | 13 | en-general-06, en-general-07, en-general-08, en-general-09, en-general-10, en-general-11, en-general-12, en-general-13, en-general-14, en-general-15, en-general-17, en-general-18, en-general-19 |
| github.com | 12 | en-tech-02, en-tech-05, en-tech-10, zh-tech-01, lt-03, xl-01, en-tech-16, kr-tech-18, kr-tech-23, en-tech-34, cmp-18, lt-16 |
| nih.gov | 12 | en-general-08, en-health-01, en-health-02, en-health-07, en-health-10, en-health-12, en-health-18, en-health-19, en-health-21, en-health-23, en-health-25, en-acad-24 |
| bbc.com | 11 | en-news-01, en-news-15, en-news-19, en-news-23, en-news-26, en-news-28, en-news-31, en-news-32, en-news-34, en-news-37, ts-09 |
| apnews.com | 11 | en-news-01, en-news-19, en-news-23, en-news-26, en-news-28, en-news-31, en-news-32, en-news-34, en-news-37, ts-09, en-news-48 |
| wired.com | 11 | en-news-19, en-news-23, en-news-26, en-news-28, en-news-31, en-news-32, en-news-34, en-news-37, ts-09, en-general-30, en-shopping-07 |
| techcrunch.com | 10 | ts-03, en-news-19, en-news-23, en-news-26, en-news-28, en-news-31, en-news-32, en-news-34, en-news-37, ts-09 |
| theguardian.com | 10 | en-news-19, en-news-23, en-news-26, en-news-28, en-news-31, en-news-32, en-news-34, en-news-37, ts-09, en-travel-09 |
| lonelyplanet.com | 10 | en-general-09, en-travel-01, en-travel-02, en-general-24, en-travel-04, en-travel-05, en-travel-06, en-travel-07, en-travel-09, en-travel-10 |
| tripadvisor.com | 9 | kr-general-02, ja-travel-02, ja-travel-03, en-travel-01, en-travel-02, en-general-24, en-travel-05, en-travel-06, en-travel-10 |
| japan-guide.com | 9 | ja-travel-02, ja-travel-03, en-travel-01, ja-general-06, ja-general-09, ja-general-10, ja-travel-06, ja-travel-08, en-travel-04 |
| cnn.com | 9 | en-news-19, en-news-23, en-news-26, en-news-28, en-news-31, en-news-32, en-news-34, en-news-37, ts-09 |
| developer.mozilla.org | 8 | kr-tech-02, kr-tech-04, en-tech-02, en-tech-12, zh-tech-01, kr-tech-18, kr-tech-23, en-tech-34 |
| ctrip.com | 8 | zh-general-06, zh-general-10, zh-general-14, zh-travel-01, zh-travel-02, zh-travel-03, zh-travel-04, zh-travel-05 |
| mafengwo.cn | 8 | zh-general-06, zh-general-10, zh-general-14, zh-travel-01, zh-travel-02, zh-travel-03, zh-travel-04, zh-travel-05 |
| xiaohongshu.com | 8 | zh-general-06, zh-general-10, zh-general-14, zh-travel-01, zh-travel-02, zh-travel-03, zh-travel-04, zh-travel-05 |
| trip.com | 8 | zh-general-06, zh-general-10, zh-general-14, zh-travel-01, zh-travel-02, zh-travel-03, zh-travel-04, zh-travel-05 |
| wikipedia.org | 6 | kr-general-04, en-fact-02, en-fact-04, gk-05, ds-04, xl-01 |
| eatingwell.com | 6 | en-general-07, en-health-03, en-health-09, en-health-15, en-health-20, en-general-26 |
| hbr.org | 5 | en-general-03, en-general-15, en-general-20, en-general-27, en-general-31 |
| zhihu.com | 5 | zh-general-05, zh-general-06, zh-general-10, zh-general-14, xl-04 |
| health.harvard.edu | 5 | en-health-05, en-health-12, en-health-15, en-health-19, en-health-25 |
| cdc.gov | 5 | en-health-05, en-health-10, en-health-11, en-health-19, en-health-21 |
| qunar.com | 5 | zh-travel-01, zh-travel-02, zh-travel-03, zh-travel-04, zh-travel-05 |
| yahoo.co.jp | 5 | ja-general-06, ja-general-09, ja-general-10, ja-travel-06, ja-travel-08 |
| tripadvisor.jp | 5 | ja-general-06, ja-general-09, ja-general-10, ja-travel-06, ja-travel-08 |
| rakuten.co.jp | 5 | ja-general-06, ja-general-09, ja-general-10, ja-travel-06, ja-travel-08 |
| medicalnewstoday.com | 5 | en-health-07, en-health-11, en-health-16, en-health-18, en-health-20 |
| thebalancemoney.com | 5 | en-general-20, en-general-25, en-general-27, en-general-31, en-stock-28 |
| britannica.com | 4 | en-fact-02, en-fact-04, gk-13, en-fact-50 |
| ithome.com | 4 | zh-news-02, xl-02, zh-general-05, zh-news-18 |
| aws.amazon.com | 4 | cmp-02, ds-04, ja-tech-04, cmp-21 |
| openai.com | 4 | cmp-03, xl-01, adv-10, xl-04 |
| cnet.com | 4 | adv-05, en-general-33, en-shopping-03, en-shopping-07 |
| stackoverflow.com | 4 | kr-tech-18, kr-tech-23, en-tech-34, cmp-19 |
| investopedia.com | 4 | en-general-12, gk-12, en-general-25, en-stock-28 |
| indeed.com | 4 | en-general-15, en-general-20, en-general-27, en-general-31 |
| hopkinsmedicine.org | 4 | en-health-01, en-health-08, en-health-16, en-health-22 |
| apa.org | 4 | en-health-04, en-health-13, en-health-17, en-health-24 |
| blog.naver.com | 3 | kr-general-02, kr-general-07, kr-special-01 |
| cloudflare.com | 3 | lt-01, gk-05, ds-04 |
| 36kr.com | 3 | xl-02, xl-04, zh-news-18 |
| investing.com | 3 | kr-stock-13, kr-special-04, en-stock-29 |
| medium.com | 3 | kr-tech-18, kr-tech-23, en-tech-34 |
| ricksteves.com | 3 | en-general-09, en-general-24, en-travel-07 |
| fool.com | 3 | en-general-12, en-general-25, en-stock-28 |
| nomadicmatt.com | 3 | en-travel-02, en-general-24, en-travel-05 |
| dianping.com | 3 | zh-general-06, zh-general-10, zh-general-14 |
| arxiv.org | 3 | adv-10, ds-14, en-acad-25 |
| nimh.nih.gov | 3 | en-health-13, en-health-17, en-health-24 |
| nature.com | 3 | en-acad-21, en-acad-24, en-acad-25 |
| science.org | 3 | en-acad-21, en-acad-24, en-acad-25 |
| timeout.com | 3 | en-travel-04, en-travel-06, en-travel-10 |
| cntraveler.com | 3 | en-travel-04, en-travel-06, en-travel-09 |
| react.dev | 2 | en-tech-02, zh-tech-01 |
| blog.google | 2 | en-news-03, xl-02 |
| npr.org | 2 | en-news-07, en-general-30 |
| krebsonsecurity.com | 2 | en-news-09, ca-03 |
| iea.org | 2 | en-news-10, ca-04 |
| cloud.google.com | 2 | cmp-02, cmp-19 |
| techradar.com | 2 | ts-04, en-shopping-01 |
| cnbc.com | 2 | ts-04, en-stock-29 |
| postgresql.org | 2 | en-tech-15, cmp-09 |
| mysql.com | 2 | en-tech-15, cmp-09 |
| sec.gov | 2 | en-news-12, gk-12 |
| ipcc.ch | 2 | en-news-15, en-acad-21 |
| duolingo.com | 2 | en-general-04, en-general-34 |
| finance.naver.com | 2 | kr-stock-13, kr-special-04 |
| m.stock.naver.com | 2 | kr-stock-13, kr-special-04 |
| velog.io | 2 | kr-tech-18, kr-tech-23 |
| inflearn.com | 2 | kr-tech-18, kr-tech-23 |
| tistory.com | 2 | kr-tech-18, kr-tech-23 |
| dev.to | 2 | en-tech-34, en-general-10 |
| electrek.co | 2 | en-news-28, en-news-34 |
| nerdfitness.com | 2 | en-general-06, en-general-23 |
| budgetbytes.com | 2 | en-general-07, en-general-26 |
| sleepfoundation.org | 2 | en-general-08, en-health-10 |
| lifehacker.com | 2 | en-general-13, en-general-28 |
| apartmenttherapy.com | 2 | en-general-17, en-general-28 |
| rtings.com | 2 | en-shopping-01, en-shopping-02 |
| pcmag.com | 2 | en-shopping-02, en-shopping-03 |
| tomshardware.com | 2 | en-shopping-02, en-shopping-03 |
| noaa.gov | 2 | gk-13, en-fact-46 |
| glassdoor.com | 2 | en-general-20, en-general-27 |
| thespruce.com | 2 | en-general-22, en-general-28 |
| nationalgeographic.com | 2 | en-fact-46, en-fact-50 |
| scientificamerican.com | 2 | en-fact-46, en-fact-50 |
| walmart.com | 2 | en-shopping-03, en-shopping-05 |
| typescriptlang.org | 1 | kr-tech-02 |
| nextjs.org | 1 | kr-tech-04 |
| vercel.com | 1 | kr-tech-04 |
| visitjeju.net | 1 | kr-general-02 |
| ko.wikipedia.org | 1 | kr-general-04 |
| kmdb.or.kr | 1 | kr-general-04 |
| cine21.com | 1 | kr-general-04 |
| kubernetes.io | 1 | en-tech-05 |
| webassembly.org | 1 | en-tech-12 |
| w3.org | 1 | en-tech-12 |
| fivethirtyeight.com | 1 | en-news-07 |
| electrive.com | 1 | en-news-10 |
| ibm.com | 1 | en-fact-04 |
| huawei.com | 1 | zh-news-02 |
| people.com.cn | 1 | zh-news-02 |
| douban.com | 1 | zh-general-03 |
| maoyan.com | 1 | zh-general-03 |
| zh.wikipedia.org | 1 | zh-general-03 |
| kyoto.travel | 1 | ja-travel-02 |
| azure.microsoft.com | 1 | cmp-02 |
| anthropic.com | 1 | cmp-03 |
| gemini.google.com | 1 | cmp-03 |
| bun.sh | 1 | lt-03 |
| iana.org | 1 | gk-05 |
| europa.eu | 1 | ca-01 |
| cisa.gov | 1 | ca-03 |
| energy.gov | 1 | ca-04 |
| waymo.com | 1 | ca-05 |
| tesla.com | 1 | ca-05 |
| hyundai.com | 1 | kr-general-07 |
| kia.com | 1 | kr-general-07 |
| use-the-index-luke.com | 1 | en-tech-15 |
| rust-lang.org | 1 | en-tech-16 |
| coindesk.com | 1 | en-news-12 |
| bloomberg.com | 1 | en-news-13 |
| semi.org | 1 | en-news-13 |
| forbes.com | 1 | en-general-03 |
| blog.hubspot.com | 1 | en-general-03 |
| bbc.co.uk | 1 | en-general-04 |
| fluentin3months.com | 1 | en-general-04 |
| zdm.com | 1 | zh-general-05 |
| qiita.com | 1 | ja-tech-04 |
| aws.amazon.co.jp | 1 | ja-tech-04 |
| okinawatravelinfo.com | 1 | ja-travel-03 |
| sqlite.org | 1 | cmp-09 |
| gsmarena.com | 1 | adv-05 |
| thebell.co.kr | 1 | kr-stock-13 |
| owasp.org | 1 | kr-tech-18 |
| jestjs.io | 1 | kr-tech-23 |
| namu.wiki | 1 | kr-special-01 |
| terms.naver.com | 1 | kr-special-01 |
| youtube.com | 1 | kr-special-01 |
| goldprice.org | 1 | kr-special-04 |
| freecodecamp.org | 1 | en-tech-34 |
| digitalocean.com | 1 | en-tech-34 |
| web.dev | 1 | en-tech-34 |
| huggingface.co | 1 | en-news-19 |
| datacenterdynamics.com | 1 | en-news-23 |
| fao.org | 1 | en-news-26 |
| gartner.com | 1 | en-news-31 |
| statnews.com | 1 | en-news-32 |
| canarymedia.com | 1 | en-news-37 |
| spotify.com | 1 | en-general-10 |
| headspace.com | 1 | en-general-11 |
| goodreads.com | 1 | en-general-14 |
| coursera.org | 1 | en-general-18 |
| edx.org | 1 | en-general-18 |
| whathifi.com | 1 | en-shopping-01 |
| ja.wikipedia.org | 1 | ja-fact-10 |
| kotobank.jp | 1 | ja-fact-10 |
| weblio.jp | 1 | ja-fact-10 |
| bookmeter.com | 1 | ja-general-09 |
| honto.jp | 1 | ja-general-09 |
| pytorch.org | 1 | cmp-18 |
| tensorflow.org | 1 | cmp-18 |
| snowflake.com | 1 | cmp-19 |
| apple.com | 1 | cmp-20 |
| linux.org | 1 | cmp-20 |
| docker.com | 1 | cmp-21 |
| serverless.com | 1 | cmp-21 |
| developers.cloudflare.com | 1 | lt-16 |
| en.wikipedia.org | 1 | gk-12 |
| deepmind.google | 1 | adv-10 |
| opensource.org | 1 | adv-12 |
| redhat.com | 1 | adv-12 |
| fifa.com | 1 | ts-09 |
| aclweb.org | 1 | ds-14 |
| heart.org | 1 | en-health-06 |
| runnersworld.com | 1 | en-health-14 |
| eatright.org | 1 | en-health-23 |
| politico.com | 1 | en-news-48 |
| washingtonpost.com | 1 | en-news-48 |
| almanac.com | 1 | en-general-22 |
| gardeningknowhow.com | 1 | en-general-22 |
| menshealth.com | 1 | en-general-23 |
| nerdwallet.com | 1 | en-general-25 |
| allrecipes.com | 1 | en-general-26 |
| delish.com | 1 | en-general-26 |
| zety.com | 1 | en-general-31 |
| realsimple.com | 1 | en-general-32 |
| artofmanliness.com | 1 | en-general-32 |
| survivopedia.com | 1 | en-general-32 |
| caranddriver.com | 1 | en-general-33 |
| edmunds.com | 1 | en-general-33 |
| consumerreports.org | 1 | en-general-33 |
| fluentu.com | 1 | en-general-34 |
| babbel.com | 1 | en-general-34 |
| smithsonianmag.com | 1 | en-fact-46 |
| space.com | 1 | en-fact-50 |
| nasa.gov | 1 | en-fact-50 |
| agu.org | 1 | en-acad-21 |
| pubmed.ncbi.nlm.nih.gov | 1 | en-acad-24 |
| acm.org | 1 | en-acad-25 |
| theculturetrip.com | 1 | en-travel-05 |
| seat61.com | 1 | en-travel-07 |
| trenitalia.com | 1 | en-travel-07 |
| responsibletravel.com | 1 | en-travel-09 |
| nycgo.com | 1 | en-travel-10 |
| ikea.com | 1 | en-shopping-05 |
| wayfair.com | 1 | en-shopping-05 |
| target.com | 1 | en-shopping-05 |
| bonappetit.com | 1 | en-shopping-07 |
| americastestkitchen.com | 1 | en-shopping-07 |
| corporatefinanceinstitute.com | 1 | en-stock-28 |
| marketwatch.com | 1 | en-stock-29 |
| jiqizhixin.com | 1 | zh-news-18 |
| sina.com.cn | 1 | zh-news-18 |
| caixin.com | 1 | zh-news-18 |
| itmedia.co.jp | 1 | ja-news-15 |
| nikkei.com | 1 | ja-news-15 |
| watch.impress.co.jp | 1 | ja-news-15 |
| ascii.jp | 1 | ja-news-15 |
| zdnet.com | 1 | ja-news-15 |

## 쿼리별 상세 (zero-gold 전체)

| id | kind | lang | tags | gold 도메인 | 풀 크기 |
|---|---|---|---|---|---|
| adv-05 | COVERAGE | en | english/general | cnet.com|gsmarena.com|theverge.com | 10 |
| adv-10 | COVERAGE | en | english/general | openai.com|deepmind.google|arxiv.org | 10 |
| adv-12 | COVERAGE | en | english/general | opensource.org|redhat.com | 10 |
| ca-01 | COVERAGE | en | english/news | reuters.com|europa.eu|theverge.com | 10 |
| ca-03 | COVERAGE | en | english/news | krebsonsecurity.com|reuters.com|cisa.gov | 10 |
| ca-04 | COVERAGE | en | english/news | iea.org|reuters.com|energy.gov | 10 |
| ca-05 | COVERAGE | en | english/news | reuters.com|waymo.com|tesla.com | 10 |
| cmp-02 | COVERAGE | en | english/technical/comparison | aws.amazon.com|azure.microsoft.com|cloud.google.com | 10 |
| cmp-03 | COVERAGE | en | english/technical/comparison | openai.com|anthropic.com|gemini.google.com | 10 |
| cmp-09 | COVERAGE | en | english/technical/comparison | postgresql.org|mysql.com|sqlite.org | 10 |
| cmp-18 | COVERAGE | en | english/technical/comparison | pytorch.org|tensorflow.org|github.com | 10 |
| cmp-19 | COVERAGE | en | english/technical/comparison | snowflake.com|cloud.google.com|stackoverflow.com | 10 |
| cmp-20 | COVERAGE | en | english/technical/comparison | apple.com|linux.org|reddit.com | 10 |
| cmp-21 | COVERAGE | en | english/technical/comparison | aws.amazon.com|docker.com|serverless.com | 10 |
| ds-04 | COVERAGE | en | english/technical | cloudflare.com|wikipedia.org|aws.amazon.com | 10 |
| ds-14 | COVERAGE | en | english/technical | arxiv.org|aclweb.org | 10 |
| en-acad-21 | COVERAGE | en | english/academic | nature.com|science.org|agu.org|ipcc.ch | 10 |
| en-acad-24 | COVERAGE | en | english/academic | nature.com|pubmed.ncbi.nlm.nih.gov|nih.gov|science.org | 10 |
| en-acad-25 | COVERAGE | en | english/academic | nature.com|arxiv.org|science.org|acm.org | 10 |
| en-fact-02 | COVERAGE | en | english/factual | wikipedia.org|britannica.com | 10 |
| en-fact-04 | COVERAGE | en | english/factual | wikipedia.org|britannica.com|ibm.com | 10 |
| en-fact-46 | COVERAGE | en | english/factual | noaa.gov|nationalgeographic.com|scientificamerican.com|smithsonianmag.com | 10 |
| en-fact-50 | COVERAGE | en | english/factual | space.com|nasa.gov|scientificamerican.com|britannica.com|nationalgeographic.com | 10 |
| en-general-03 | COVERAGE | en | english/general | forbes.com|hbr.org|blog.hubspot.com | 10 |
| en-general-04 | COVERAGE | en | english/general | duolingo.com|bbc.co.uk|fluentin3months.com | 10 |
| en-general-06 | COVERAGE | en | english/general | reddit.com|quora.com|healthline.com|webmd.com|nytimes.com|wikihow.com|nerdfitness.com | 10 |
| en-general-07 | COVERAGE | en | english/general | reddit.com|quora.com|healthline.com|webmd.com|nytimes.com|wikihow.com|budgetbytes.com|eatingwell.com | 7 |
| en-general-08 | COVERAGE | en | english/general | reddit.com|quora.com|healthline.com|webmd.com|nytimes.com|wikihow.com|sleepfoundation.org|nih.gov | 10 |
| en-general-09 | COVERAGE | en | english/general | reddit.com|quora.com|healthline.com|webmd.com|nytimes.com|wikihow.com|lonelyplanet.com|ricksteves.com | 10 |
| en-general-10 | COVERAGE | en | english/general | reddit.com|quora.com|healthline.com|webmd.com|nytimes.com|wikihow.com|spotify.com|dev.to | 10 |
| en-general-11 | COVERAGE | en | english/general | reddit.com|quora.com|healthline.com|webmd.com|nytimes.com|wikihow.com|headspace.com | 10 |
| en-general-12 | COVERAGE | en | english/general | reddit.com|quora.com|healthline.com|webmd.com|nytimes.com|wikihow.com|investopedia.com|fool.com | 10 |
| en-general-13 | COVERAGE | en | english/general | reddit.com|quora.com|healthline.com|webmd.com|nytimes.com|wikihow.com|lifehacker.com | 10 |
| en-general-14 | COVERAGE | en | english/general | reddit.com|quora.com|healthline.com|webmd.com|nytimes.com|wikihow.com|goodreads.com | 10 |
| en-general-15 | COVERAGE | en | english/general | reddit.com|quora.com|healthline.com|webmd.com|nytimes.com|wikihow.com|hbr.org|indeed.com | 10 |
| en-general-17 | COVERAGE | en | english/general | reddit.com|quora.com|healthline.com|webmd.com|nytimes.com|wikihow.com|apartmenttherapy.com | 10 |
| en-general-18 | COVERAGE | en | english/general | reddit.com|quora.com|healthline.com|webmd.com|nytimes.com|wikihow.com|coursera.org|edx.org | 10 |
| en-general-19 | COVERAGE | en | english/general | reddit.com|quora.com|healthline.com|webmd.com|nytimes.com|wikihow.com|mayoclinic.org | 10 |
| en-general-20 | COVERAGE | en | english/general | indeed.com|glassdoor.com|hbr.org|thebalancemoney.com | 10 |
| en-general-22 | COVERAGE | en | english/general | almanac.com|wikihow.com|thespruce.com|gardeningknowhow.com | 10 |
| en-general-23 | COVERAGE | en | english/general | healthline.com|nerdfitness.com|menshealth.com|wikihow.com | 10 |
| en-general-24 | COVERAGE | en | english/general | lonelyplanet.com|ricksteves.com|tripadvisor.com|nomadicmatt.com | 10 |
| en-general-25 | COVERAGE | en | english/general | investopedia.com|nerdwallet.com|thebalancemoney.com|fool.com | 10 |
| en-general-26 | COVERAGE | en | english/general | budgetbytes.com|eatingwell.com|allrecipes.com|delish.com | 10 |
| en-general-27 | COVERAGE | en | english/general | indeed.com|glassdoor.com|thebalancemoney.com|hbr.org | 10 |
| en-general-28 | COVERAGE | en | english/general | lifehacker.com|apartmenttherapy.com|thespruce.com|wikihow.com | 10 |
| en-general-30 | COVERAGE | en | english/general | npr.org|nytimes.com|theverge.com|wired.com | 10 |
| en-general-31 | COVERAGE | en | english/general | indeed.com|thebalancemoney.com|zety.com|hbr.org | 10 |
| en-general-32 | COVERAGE | en | english/general | wikihow.com|realsimple.com|artofmanliness.com|survivopedia.com | 10 |
| en-general-33 | COVERAGE | en | english/general | caranddriver.com|edmunds.com|cnet.com|theverge.com|consumerreports.org | 10 |
| en-general-34 | COVERAGE | en | english/general | fluentu.com|babbel.com|duolingo.com|wikihow.com | 10 |
| en-health-01 | COVERAGE | en | english/general | healthline.com|webmd.com|nih.gov|hopkinsmedicine.org | 10 |
| en-health-02 | COVERAGE | en | english/general | healthline.com|webmd.com|nih.gov|mayoclinic.org | 10 |
| en-health-03 | COVERAGE | en | english/general | healthline.com|webmd.com|eatingwell.com | 10 |
| en-health-04 | COVERAGE | en | english/general | mayoclinic.org|apa.org|healthline.com | 10 |
| en-health-05 | COVERAGE | en | english/general | health.harvard.edu|cdc.gov|mayoclinic.org | 10 |
| en-health-06 | COVERAGE | en | english/general | healthline.com|webmd.com|mayoclinic.org|heart.org | 10 |
| en-health-07 | COVERAGE | en | english/general | healthline.com|webmd.com|medicalnewstoday.com|nih.gov | 10 |
| en-health-08 | COVERAGE | en | english/general | healthline.com|webmd.com|mayoclinic.org|hopkinsmedicine.org | 10 |
| en-health-09 | COVERAGE | en | english/general | healthline.com|eatingwell.com|webmd.com|mayoclinic.org | 10 |
| en-health-10 | COVERAGE | en | english/general | sleepfoundation.org|cdc.gov|healthline.com|nih.gov | 10 |
| en-health-11 | COVERAGE | en | english/general | healthline.com|webmd.com|medicalnewstoday.com|cdc.gov | 10 |
| en-health-12 | COVERAGE | en | english/general | healthline.com|webmd.com|nih.gov|health.harvard.edu | 10 |
| en-health-13 | COVERAGE | en | english/general | apa.org|mayoclinic.org|healthline.com|nimh.nih.gov | 10 |
| en-health-14 | COVERAGE | en | english/general | healthline.com|webmd.com|mayoclinic.org|runnersworld.com | 10 |
| en-health-15 | COVERAGE | en | english/general | healthline.com|eatingwell.com|mayoclinic.org|health.harvard.edu | 10 |
| en-health-16 | COVERAGE | en | english/general | healthline.com|webmd.com|medicalnewstoday.com|hopkinsmedicine.org | 10 |
| en-health-17 | COVERAGE | en | english/general | apa.org|mayoclinic.org|nimh.nih.gov|healthline.com | 10 |
| en-health-18 | COVERAGE | en | english/general | healthline.com|webmd.com|medicalnewstoday.com|nih.gov | 10 |
| en-health-19 | COVERAGE | en | english/general | healthline.com|cdc.gov|health.harvard.edu|nih.gov | 10 |
| en-health-20 | COVERAGE | en | english/general | healthline.com|webmd.com|eatingwell.com|medicalnewstoday.com | 10 |
| en-health-21 | COVERAGE | en | english/general | cdc.gov|mayoclinic.org|healthline.com|nih.gov | 10 |
| en-health-22 | COVERAGE | en | english/general | healthline.com|webmd.com|mayoclinic.org|hopkinsmedicine.org | 10 |
| en-health-23 | COVERAGE | en | english/general | healthline.com|webmd.com|nih.gov|eatright.org | 10 |
| en-health-24 | COVERAGE | en | english/general | apa.org|healthline.com|mayoclinic.org|nimh.nih.gov | 10 |
| en-health-25 | COVERAGE | en | english/general | healthline.com|webmd.com|nih.gov|health.harvard.edu | 10 |
| en-news-01 | COVERAGE | en | english/news | reuters.com|bbc.com|apnews.com | 10 |
| en-news-03 | COVERAGE | en | english/news | reuters.com|theverge.com|blog.google | 10 |
| en-news-07 | COVERAGE | en | english/news | reuters.com|npr.org|fivethirtyeight.com | 10 |
| en-news-09 | COVERAGE | en | english/news | reuters.com|krebsonsecurity.com|theverge.com | 10 |
| en-news-10 | COVERAGE | en | english/news | reuters.com|iea.org|electrive.com | 10 |
| en-news-12 | COVERAGE | en | english/news | coindesk.com|reuters.com|sec.gov | 10 |
| en-news-13 | COVERAGE | en | english/news | reuters.com|bloomberg.com|semi.org | 10 |
| en-news-15 | COVERAGE | en | english/news | ipcc.ch|reuters.com|bbc.com | 10 |
| en-news-19 | COVERAGE | en | english/news | reuters.com|apnews.com|bbc.com|cnn.com|theverge.com|techcrunch.com|theguardian.com|nytimes.com|wired.com|huggingface.co | 10 |
| en-news-23 | COVERAGE | en | english/news | reuters.com|apnews.com|bbc.com|cnn.com|theverge.com|techcrunch.com|theguardian.com|nytimes.com|wired.com|datacenterdynamics.com | 10 |
| en-news-26 | COVERAGE | en | english/news | reuters.com|apnews.com|bbc.com|cnn.com|theverge.com|techcrunch.com|theguardian.com|nytimes.com|wired.com|fao.org | 10 |
| en-news-28 | COVERAGE | en | english/news | reuters.com|apnews.com|bbc.com|cnn.com|theverge.com|techcrunch.com|theguardian.com|nytimes.com|wired.com|electrek.co | 10 |
| en-news-31 | COVERAGE | en | english/news | reuters.com|apnews.com|bbc.com|cnn.com|theverge.com|techcrunch.com|theguardian.com|nytimes.com|wired.com|gartner.com | 10 |
| en-news-32 | COVERAGE | en | english/news | reuters.com|apnews.com|bbc.com|cnn.com|theverge.com|techcrunch.com|theguardian.com|nytimes.com|wired.com|statnews.com | 10 |
| en-news-34 | COVERAGE | en | english/news | reuters.com|apnews.com|bbc.com|cnn.com|theverge.com|techcrunch.com|theguardian.com|nytimes.com|wired.com|electrek.co | 10 |
| en-news-37 | COVERAGE | en | english/news | reuters.com|apnews.com|bbc.com|cnn.com|theverge.com|techcrunch.com|theguardian.com|nytimes.com|wired.com|canarymedia.com | 10 |
| en-news-48 | COVERAGE | en | english/news | politico.com|reuters.com|apnews.com|nytimes.com|washingtonpost.com | 10 |
| en-shopping-01 | COVERAGE | en | english/general | rtings.com|whathifi.com|techradar.com | 10 |
| en-shopping-02 | COVERAGE | en | english/general | rtings.com|pcmag.com|tomshardware.com | 10 |
| en-shopping-03 | COVERAGE | en | english/general | pcmag.com|cnet.com|tomshardware.com|walmart.com | 10 |
| en-shopping-05 | COVERAGE | en | english/general | ikea.com|wayfair.com|target.com|walmart.com | 10 |
| en-shopping-07 | COVERAGE | en | english/general | cnet.com|wired.com|bonappetit.com|americastestkitchen.com | 10 |
| en-stock-28 | COVERAGE | en | english/financial | investopedia.com|corporatefinanceinstitute.com|fool.com|thebalancemoney.com | 10 |
| en-stock-29 | COVERAGE | en | english/financial | investing.com|marketwatch.com|cnbc.com|reuters.com | 10 |
| en-tech-02 | COVERAGE | en | english/technical | react.dev|developer.mozilla.org|github.com | 10 |
| en-tech-05 | COVERAGE | en | english/technical | kubernetes.io|github.com | 10 |
| en-tech-10 | COVERAGE | en | english/technical | github.com | 10 |
| en-tech-12 | COVERAGE | en | english/technical | webassembly.org|developer.mozilla.org|w3.org | 10 |
| en-tech-15 | COVERAGE | en | english/technical | postgresql.org|mysql.com|use-the-index-luke.com | 10 |
| en-tech-16 | COVERAGE | en | english/technical | rust-lang.org|github.com | 10 |
| en-tech-34 | COVERAGE | en | english/technical | github.com|stackoverflow.com|developer.mozilla.org|dev.to|medium.com|freecodecamp.org|digitalocean.com|web.dev | 10 |
| en-travel-01 | COVERAGE | en | english/general | japan-guide.com|lonelyplanet.com|tripadvisor.com | 10 |
| en-travel-02 | COVERAGE | en | english/general | lonelyplanet.com|nomadicmatt.com|tripadvisor.com | 10 |
| en-travel-04 | COVERAGE | en | english/general | japan-guide.com|lonelyplanet.com|timeout.com|cntraveler.com | 10 |
| en-travel-05 | COVERAGE | en | english/general | lonelyplanet.com|tripadvisor.com|nomadicmatt.com|theculturetrip.com | 10 |
| en-travel-06 | COVERAGE | en | english/general | lonelyplanet.com|tripadvisor.com|timeout.com|cntraveler.com | 10 |
| en-travel-07 | COVERAGE | en | english/general | ricksteves.com|lonelyplanet.com|seat61.com|trenitalia.com | 9 |
| en-travel-09 | COVERAGE | en | english/general | lonelyplanet.com|cntraveler.com|responsibletravel.com|theguardian.com | 10 |
| en-travel-10 | COVERAGE | en | english/general | lonelyplanet.com|tripadvisor.com|timeout.com|nycgo.com | 10 |
| gk-05 | COVERAGE | en | english/factual | wikipedia.org|cloudflare.com|iana.org | 10 |
| gk-12 | COVERAGE | en | english/factual | investopedia.com|sec.gov|en.wikipedia.org | 10 |
| gk-13 | COVERAGE | en | english/factual | noaa.gov|britannica.com | 10 |
| ja-fact-10 | COVERAGE | ja | japanese/factual | ja.wikipedia.org|kotobank.jp|weblio.jp | 5 |
| ja-general-06 | COVERAGE | ja | japanese/general | yahoo.co.jp|tripadvisor.jp|japan-guide.com|rakuten.co.jp | 10 |
| ja-general-09 | COVERAGE | ja | japanese/general | yahoo.co.jp|tripadvisor.jp|japan-guide.com|rakuten.co.jp|bookmeter.com|honto.jp | 10 |
| ja-general-10 | COVERAGE | ja | japanese/general | yahoo.co.jp|tripadvisor.jp|japan-guide.com|rakuten.co.jp | 10 |
| ja-news-15 | COVERAGE | ja | japanese/news | itmedia.co.jp|nikkei.com|watch.impress.co.jp|ascii.jp|zdnet.com | 10 |
| ja-tech-04 | COVERAGE | ja | japanese/technical | aws.amazon.com|qiita.com|aws.amazon.co.jp | 10 |
| ja-travel-02 | COVERAGE | ja | japanese/general | kyoto.travel|tripadvisor.com|japan-guide.com | 5 |
| ja-travel-03 | COVERAGE | ja | japanese/general | okinawatravelinfo.com|tripadvisor.com|japan-guide.com | 10 |
| ja-travel-06 | COVERAGE | ja | japanese/general | yahoo.co.jp|tripadvisor.jp|japan-guide.com|rakuten.co.jp | 10 |
| ja-travel-08 | COVERAGE | ja | japanese/general | yahoo.co.jp|tripadvisor.jp|japan-guide.com|rakuten.co.jp | 5 |
| kr-general-02 | COVERAGE | kr | korean/general | visitjeju.net|blog.naver.com|tripadvisor.com | 10 |
| kr-general-04 | COVERAGE | kr | korean/general | ko.wikipedia.org|wikipedia.org|kmdb.or.kr|cine21.com | 10 |
| kr-general-07 | COVERAGE | kr | korean/general | hyundai.com|kia.com|blog.naver.com | 10 |
| kr-special-01 | COVERAGE | kr | korean/general | namu.wiki|blog.naver.com|terms.naver.com|youtube.com | 10 |
| kr-special-04 | COVERAGE | kr | korean/financial | finance.naver.com|m.stock.naver.com|investing.com|goldprice.org | 10 |
| kr-stock-13 | COVERAGE | kr | korean/financial | finance.naver.com|m.stock.naver.com|investing.com|thebell.co.kr | 10 |
| kr-tech-02 | COVERAGE | kr | korean/technical | typescriptlang.org|developer.mozilla.org | 10 |
| kr-tech-04 | COVERAGE | kr | korean/technical | nextjs.org|vercel.com|developer.mozilla.org | 10 |
| kr-tech-18 | COVERAGE | kr | korean/technical | github.com|stackoverflow.com|velog.io|inflearn.com|tistory.com|medium.com|developer.mozilla.org|owasp.org | 10 |
| kr-tech-23 | COVERAGE | kr | korean/technical | github.com|stackoverflow.com|velog.io|inflearn.com|tistory.com|medium.com|developer.mozilla.org|jestjs.io | 10 |
| lt-01 | COVERAGE | en | english/technical | cloudflare.com | 10 |
| lt-03 | COVERAGE | en | english/technical | bun.sh|github.com | 10 |
| lt-16 | COVERAGE | en | english/technical | developers.cloudflare.com|github.com | 10 |
| ts-03 | COVERAGE | en | english/news | reuters.com|techcrunch.com|theverge.com | 10 |
| ts-04 | COVERAGE | en | english/news | theverge.com|techradar.com|cnbc.com | 10 |
| ts-09 | COVERAGE | en | english/news | reuters.com|apnews.com|bbc.com|cnn.com|theverge.com|techcrunch.com|theguardian.com|nytimes.com|wired.com|fifa.com | 10 |
| xl-01 | COVERAGE | kr | korean/technical/comparison | openai.com|wikipedia.org|github.com | 10 |
| xl-02 | COVERAGE | zh | chinese/news | blog.google|36kr.com|ithome.com | 10 |
| xl-04 | COVERAGE | zh | chinese/technical/comparison | zhihu.com|36kr.com|openai.com | 4 |
| zh-general-03 | COVERAGE | zh | chinese/general | douban.com|maoyan.com|zh.wikipedia.org | 10 |
| zh-general-05 | COVERAGE | zh | chinese/general | zdm.com|ithome.com|zhihu.com | 10 |
| zh-general-06 | COVERAGE | zh | chinese/general | ctrip.com|mafengwo.cn|dianping.com|xiaohongshu.com|zhihu.com|trip.com | 10 |
| zh-general-10 | COVERAGE | zh | chinese/general | ctrip.com|mafengwo.cn|dianping.com|xiaohongshu.com|zhihu.com|trip.com | 10 |
| zh-general-14 | COVERAGE | zh | chinese/general | ctrip.com|mafengwo.cn|dianping.com|xiaohongshu.com|zhihu.com|trip.com | 10 |
| zh-news-02 | COVERAGE | zh | chinese/news | huawei.com|people.com.cn|ithome.com | 10 |
| zh-news-18 | COVERAGE | zh | chinese/news | 36kr.com|ithome.com|jiqizhixin.com|sina.com.cn|caixin.com | 10 |
| zh-tech-01 | COVERAGE | zh | chinese/technical | developer.mozilla.org|github.com|react.dev | 10 |
| zh-travel-01 | COVERAGE | zh | chinese/general | ctrip.com|mafengwo.cn|xiaohongshu.com|trip.com|qunar.com | 8 |
| zh-travel-02 | COVERAGE | zh | chinese/general | ctrip.com|mafengwo.cn|xiaohongshu.com|trip.com|qunar.com | 8 |
| zh-travel-03 | COVERAGE | zh | chinese/general | ctrip.com|mafengwo.cn|xiaohongshu.com|trip.com|qunar.com | 10 |
| zh-travel-04 | COVERAGE | zh | chinese/general | ctrip.com|mafengwo.cn|xiaohongshu.com|trip.com|qunar.com | 10 |
| zh-travel-05 | COVERAGE | zh | chinese/general | ctrip.com|mafengwo.cn|xiaohongshu.com|trip.com|qunar.com | 10 |

## COVERAGE/EMPTY 쿼리의 백엔드 구성 (상위 12)

| 백엔드 | 쿼리 수 |
|---|---|
| bing | 154 |
| hackernews | 91 |
| dbpedia | 87 |
| google-news-rss | 41 |
| github | 35 |
| news-outlet | 31 |
| bing-news-rss | 30 |
| bing-news | 29 |
| wikipedia | 28 |
| stack-exchange | 25 |
| github-issues | 18 |
| reddit | 13 |