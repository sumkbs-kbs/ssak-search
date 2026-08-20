#!/usr/bin/env python3
"""
10,000+ 시드 URL 생성기
카테고리별로 기술 문서, 뉴스, 학술, 교육, 금융 등 다양한 소스에서 URL 생성
"""

import json
import random
from pathlib import Path
from typing import Dict, List, Set

# ============================================================
# 카테고리별 시드 URL 정의
# ============================================================

SEED_DATA: Dict[str, List[str]] = {
    # 1. 기술 문서 (프로그래밍, 프레임워크, 라이브러리)
    "tech-docs": [
        # Python 생태계
        "https://docs.python.org/3/tutorial/",
        "https://docs.python.org/3/library/",
        "https://docs.python.org/3/howto/",
        "https://pypi.org/project/requests/",
        "https://pypi.org/project/numpy/",
        "https://pypi.org/project/pandas/",
        "https://pypi.org/project/scikit-learn/",
        "https://pypi.org/project/tensorflow/",
        "https://pypi.org/project/pytorch/",
        "https://pypi.org/project/django/",
        "https://pypi.org/project/flask/",
        "https://pypi.org/project/fastapi/",
        "https://pypi.org/project/sqlalchemy/",
        "https://pypi.org/project/celery/",
        "https://pypi.org/project/redis/",
        # JavaScript/TypeScript 생태계
        "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
        "https://developer.mozilla.org/en-US/docs/Web/HTML",
        "https://developer.mozilla.org/en-US/docs/Web/CSS",
        "https://nodejs.org/en/docs/",
        "https://www.typescriptlang.org/docs/",
        "https://react.dev/learn",
        "https://react.dev/reference",
        "https://vuejs.org/guide/",
        "https://vuejs.org/api/",
        "https://angular.dev/overview",
        "https://nextjs.org/docs",
        "https://nuxt.com/docs",
        "https://svelte.dev/docs",
        "https://svelte.dev/tutorial",
        "https://remix.run/docs",
        "https://astro.build/docs/",
        # 라이브러리
        "https://lodash.com/docs/",
        "https://axios-http.com/docs/intro",
        "https://zod.dev/",
        "https://prisma.io/docs",
        "https://typeorm.io/",
        "https://sequelize.org/docs/v6/",
        "https://mongoosejs.com/docs/",
        "https://knexjs.org/",
        "https://trpc.io/docs",
        "https://graphql.org/learn/",
        # DevOps
        "https://docs.docker.com/get-started/",
        "https://docs.docker.com/compose/",
        "https://docs.docker.com/engine/",
        "https://kubernetes.io/docs/home/",
        "https://kubernetes.io/docs/concepts/",
        "https://kubernetes.io/docs/tasks/",
        "https://kubernetes.io/docs/reference/",
        "https://helm.sh/docs/",
        "https://www.terraform.io/docs",
        "https://developer.hashicorp.com/terraform/cli",
        "https://docs.ansible.com/",
        "https://docs.github.com/en/actions",
        "https://docs.github.com/en/rest",
        # 클라우드
        "https://docs.aws.amazon.com/",
        "https://docs.microsoft.com/en-us/azure/",
        "https://cloud.google.com/docs",
        "https://developers.cloudflare.com/workers/",
        "https://developers.cloudflare.com/pages/",
        "https://developers.cloudflare.com/r2/",
        "https://developers.cloudflare.com/d1/",
        "https://developers.cloudflare.com/vectorize/",
        "https://developers.cloudflare.com/ai/",
        "https://docs.digitalocean.com/products/",
        "https://docs.hetzner.cloud/",
        # 데이터베이스
        "https://www.postgresql.org/docs/",
        "https://dev.mysql.com/doc/",
        "https://www.mongodb.com/docs/",
        "https://redis.io/docs/",
        "https://neo4j.com/docs/",
        "https://elasticsearch.co/docs/",
        "https://www.prisma.io/docs",
        "https://planetscale.com/docs",
        "https://supabase.com/docs",
        "https://firebase.google.com/docs",
        # 보안
        "https://owasp.org/www-project-top-ten/",
        "https://cheatsheetseries.owasp.org/",
        "https://cwe.mitre.org/",
        "https://nvd.nist.gov/",
        # 알고리즘
        "https://cp-algorithms.com/",
        "https://www.geeksforgeeks.org/fundamentals-of-algorithms/",
        "https://visualgo.net/",
        "https://algorithm-visualizer.org/",
    ],
    
    # 2. 프레임워크/라이브러리 문서
    "frameworks": [
        # React 관련
        "https://react.dev/learn/thinking-in-react",
        "https://react.dev/learn/managing-state",
        "https://react.dev/learn/passing-data-deeply-with-context",
        "https://react.dev/reference/react/useState",
        "https://react.dev/reference/react/useEffect",
        "https://react.dev/reference/react/useCallback",
        "https://react.dev/reference/react/useMemo",
        "https://react.dev/reference/react/useRef",
        "https://react.dev/reference/react/useReducer",
        "https://react.dev/reference/react/useContext",
        "https://react.dev/reference/react/forwardRef",
        "https://react.dev/reference/react/lazy",
        "https://react.dev/reference/react/Suspense",
        # Next.js
        "https://nextjs.org/docs/app/building-your-application",
        "https://nextjs.org/docs/app/api-reference",
        "https://nextjs.org/docs/app/building-your-application/routing",
        "https://nextjs.org/docs/app/building-your-application/data-fetching",
        "https://nextjs.org/docs/app/building-your-application/rendering",
        "https://nextjs.org/docs/app/building-your-application/optimizing",
        "https://nextjs.org/docs/app/building-your-application/testing",
        "https://nextjs.org/docs/app/building-your-application/deploying",
        # Vue.js
        "https://vuejs.org/guide/essentials/reactivity-fundamentals.html",
        "https://vuejs.org/guide/essentials/computed.html",
        "https://vuejs.org/guide/essentials/watchers.html",
        "https://vuejs.org/guide/essentials/lifecycle.html",
        "https://vuejs.org/guide/essentials/template-refs.html",
        "https://vuejs.org/guide/components/props.html",
        "https://vuejs.org/guide/components/attrs.html",
        "https://vuejs.org/guide/components/slots.html",
        # Tailwind CSS
        "https://tailwindcss.com/docs/utility-first",
        "https://tailwindcss.com/docs/hover-focus-and-other-states",
        "https://tailwindcss.com/docs/responsive-design",
        "https://tailwindcss.com/docs/dark-mode",
        "https://tailwindcss.com/docs/animation",
        "https://tailwindcss.com/docs/customizing-colors",
        "https://tailwindcss.com/docs/functions-and-directives",
        # Bootstrap
        "https://getbootstrap.com/docs/5.3/getting-started/introduction/",
        "https://getbootstrap.com/docs/5.3/layout/overview/",
        "https://getbootstrap.com/docs/5.3/content/typography/",
        "https://getbootstrap.com/docs/5.3/components/alerts/",
        "https://getbootstrap.com/docs/5.3/forms/overview/",
        "https://getbootstrap.com/docs/5.3/utilities/api/",
        # Material UI
        "https://mui.com/material-ui/getting-started/",
        "https://mui.com/material-ui/react-button/",
        "https://mui.com/material-ui/react-text-field/",
        "https://mui.com/material-ui/react-select/",
        "https://mui.com/material-ui/react-table/",
        "https://mui.com/material-ui/react-dialog/",
        # Ant Design
        "https://ant.design/docs/react/introduce",
        "https://ant.design/docs/react/getting-started",
        "https://ant.design/components/button",
        "https://ant.design/components/form",
        "https://ant.design/components/table",
        "https://ant.design/components/modal",
        # Chakra UI
        "https://www.chakra-ui.com/docs/getting-started",
        "https://www.chakra-ui.com/docs/components/button",
        "https://www.chakra-ui.com/docs/components/input",
        "https://www.chakra-ui.com/docs/components/modal",
        "https://www.chakra-ui.com/docs/components/toast",
        # Headless UI
        "https://headlessui.com/",
        "https://headlessui.com/react/menu",
        "https://headlessui.com/react/dialog",
        "https://headlessui.com/react/listbox",
        "https://headlessui.com/react/switch",
        # Zustand
        "https://zustand-demo.pmnd.rs/",
        "https://github.com/pmndrs/zustand",
        # Redux
        "https://redux.js.org/introduction/getting-started",
        "https://redux.js.org/tutorials/essentials/part-1-overview-concepts",
        "https://redux.js.org/tutorials/essentials/part-2-app-structure",
        "https://redux.js.org/tutorials/essentials/part-3-data-flow",
        "https://redux.js.org/tutorials/essentials/part-4-using-data",
        "https://redux.js.org/tutorials/essentials/part-5-async-logic",
        "https://redux.js.org/tutorials/essentials/part-6-performance-normalization",
        # TanStack Query
        "https://tanstack.com/query/latest/docs/overview",
        "https://tanstack.com/query/latest/docs/guides/quick-start",
        "https://tanstack.com/query/latest/docs/guides/queries",
        "https://tanstack.com/query/latest/docs/guides/mutations",
        "https://tanstack.com/query/latest/docs/guides/query-invalidation",
        "https://tanstack.com/query/latest/docs/guides/prefetching",
        # Vite
        "https://vitejs.dev/guide/",
        "https://vitejs.dev/config/",
        "https://vitejs.dev/guide/features.html",
        "https://vitejs.dev/guide/plugins.html",
        "https://vitejs.dev/guide/build.html",
        # Webpack
        "https://webpack.js.org/guides/getting-started/",
        "https://webpack.js.org/configuration/",
        "https://webpack.js.org/loaders/",
        "https://webpack.js.org/plugins/",
        "https://webpack.js.org/code-splitting/",
        # Rollup
        "https://rollupjs.org/guide/en/",
        "https://rollupjs.org/configuration-options/",
        "https://rollupjs.org/plugin-development/",
        # esbuild
        "https://esbuild.github.io/",
        "https://esbuild.github.io/api/",
        "https://esbuild.github.io/plugins/",
        # SWC
        "https://swc.rs/",
        "https://swc.rs/docs/configuring-swc",
        "https://swc.rs/docs/plugins/",
    ],
    
    # 3. 프로그래밍 언어
    "languages": [
        # Python
        "https://docs.python.org/3/tutorial/classes.html",
        "https://docs.python.org/3/tutorial/modules.html",
        "https://docs.python.org/3/tutorial/errors.html",
        "https://docs.python.org/3/tutorial/inputoutput.html",
        "https://docs.python.org/3/tutorial/stdlib.html",
        "https://docs.python.org/3/tutorial/stdlib2.html",
        "https://docs.python.org/3/tutorial/venv.html",
        "https://docs.python.org/3/tutorial/whatnow.html",
        "https://docs.python.org/3/tutorial/interactive.html",
        "https://docs.python.org/3/tutorial/floatingpoint.html",
        # JavaScript
        "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array",
        "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object",
        "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String",
        "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number",
        "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map",
        "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set",
        "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise",
        "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy",
        "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Reflect",
        "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol",
        # TypeScript
        "https://www.typescriptlang.org/docs/handbook/basic-types.html",
        "https://www.typescriptlang.org/docs/handbook/interfaces.html",
        "https://www.typescriptlang.org/docs/handbook/functions.html",
        "https://www.typescriptlang.org/docs/handbook/generics.html",
        "https://www.typescriptlang.org/docs/handbook/enums.html",
        "https://www.typescriptlang.org/docs/handbook/utility-types.html",
        "https://www.typescriptlang.org/docs/handbook/advanced-types.html",
        "https://www.typescriptlang.org/docs/handbook/declaration-files.html",
        # Rust
        "https://doc.rust-lang.org/book/",
        "https://doc.rust-lang.org/book/ch03-02-data-types.html",
        "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html",
        "https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html",
        "https://doc.rust-lang.org/book/ch05-01-defining-structs.html",
        "https://doc.rust-lang.org/book/ch06-01-defining-enums.html",
        "https://doc.rust-lang.org/book/ch08-01-vectors.html",
        "https://doc.rust-lang.org/book/ch08-02-strings.html",
        "https://doc.rust-lang.org/book/ch09-01-unrecoverable-errors-with-panic.html",
        "https://doc.rust-lang.org/book/ch10-01-generics.html",
        # Go
        "https://go.dev/tour/welcome/1",
        "https://go.dev/tour/basics/1",
        "https://go.dev/tour/basics/2",
        "https://go.dev/tour/basics/3",
        "https://go.dev/tour/basics/4",
        "https://go.dev/tour/basics/5",
        "https://go.dev/tour/moretypes/1",
        "https://go.dev/tour/moretypes/2",
        "https://go.dev/tour/methods/1",
        "https://go.dev/tour/interfaces/1",
        # Java
        "https://docs.oracle.com/en/java/",
        "https://docs.oracle.com/javase/tutorial/",
        "https://docs.oracle.com/javase/tutorial/java/concepts/index.html",
        "https://docs.oracle.com/javase/tutorial/javaOO/index.html",
        "https://docs.oracle.com/javase/tutorial/java/javaOO/classes.html",
        "https://docs.oracle.com/javase/tutorial/java/javaOO/interfaces.html",
        "https://docs.oracle.com/javase/tutorial/java/javaOO/lambdaexpressions.html",
        "https://docs.oracle.com/javase/tutorial/java/collections/index.html",
        # C++
        "https://isocpp.org/get-started",
        "https://isocpp.org/faq",
        "https://en.cppreference.com/w/",
        "https://en.cppreference.com/w/cpp/language",
        "https://en.cppreference.com/w/cpp/container",
        "https://en.cppreference.com/w/cpp/algorithm",
        "https://en.cppreference.com/w/cpp/memory",
        "https://en.cppreference.com/w/cpp/thread",
        # C#
        "https://learn.microsoft.com/en-us/dotnet/csharp/",
        "https://learn.microsoft.com/en-us/dotnet/csharp/tour-of-csharp/",
        "https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/",
        "https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/",
        "https://learn.microsoft.com/en-us/dotnet/csharp/linq/",
        "https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/",
        # Swift
        "https://docs.swift.org/swift-book/documentation/the-swift-programming-language/",
        "https://docs.swift.org/swift-book/documentation/the-swift-programming-language/thebasics/",
        "https://docs.swift.org/swift-book/documentation/the-swift-programming-language/collectiontypes/",
        "https://docs.swift.org/swift-book/documentation/the-swift-programming-language/classesandstructures/",
        "https://docs.swift.org/swift-book/documentation/the-swift-programming-language/enumerations/",
        # Kotlin
        "https://kotlinlang.org/docs/home.html",
        "https://kotlinlang.org/docs/basic-syntax.html",
        "https://kotlinlang.org/docs/control-flow.html",
        "https://kotlinlang.org/docs/classes.html",
        "https://kotlinlang.org/docs/null-safety.html",
        "https://kotlinlang.org/docs/coroutines-guide.html",
        # Ruby
        "https://ruby-doc.org/stdlib-3.1.0/",
        "https://ruby-doc.org/core-3.1.0/",
        "https://ruby-doc.org/stdlib-3.1.0/libdoc/net/http/rdoc/Net/HTTP.html",
        "https://ruby-doc.org/stdlib-3.1.0/libdoc/json/rdoc/JSON.html",
        # PHP
        "https://www.php.net/manual/en/",
        "https://www.php.net/manual/en/getting-started.php",
        "https://www.php.net/manual/en/language.php5-syntax.php",
        "https://www.php.net/manual/en/language.oop5.php",
        "https://www.php.net/manual/en/language.exceptions.php",
        "https://www.php.net/manual/en/ref.filesystem.php",
        "https://www.php.net/manual/en/ref.pdo.php",
    ],
    
    # 4. 과학/학술
    "science": [
        # arXiv 논문
        "https://arxiv.org/abs/2301.07041",
        "https://arxiv.org/abs/2302.13971",
        "https://arxiv.org/abs/2303.08774",
        "https://arxiv.org/abs/2304.13712",
        "https://arxiv.org/abs/2305.18290",
        "https://arxiv.org/abs/2306.00317",
        "https://arxiv.org/abs/2307.09288",
        "https://arxiv.org/abs/2308.12950",
        "https://arxiv.org/abs/2309.10312",
        "https://arxiv.org/abs/2310.06825",
        "https://arxiv.org/abs/2311.02462",
        "https://arxiv.org/abs/2312.11017",
        # Nature
        "https://www.nature.com/articles/s41586-023-06035-6",
        "https://www.nature.com/articles/s41586-023-06350-0",
        "https://www.nature.com/articles/s41586-023-06749-x",
        "https://www.nature.com/articles/s41586-024-07054-3",
        "https://www.nature.com/articles/s41586-024-07487-w",
        # Science
        "https://www.science.org/doi/10.1126/science.adf7742",
        "https://www.science.org/doi/10.1126/science.adg8146",
        "https://www.science.org/doi/10.1126/science.adk8360",
        # PNAS
        "https://www.pnas.org/doi/10.1073/pnas.2308754120",
        "https://www.pnas.org/doi/10.1073/pnas.2310650120",
        # MIT Technology Review
        "https://www.technologyreview.com/",
        "https://www.technologyreview.com/artificial-intelligence/",
        "https://www.technologyreview.com/computing/",
        "https://www.technologyreview.com/energy/",
        "https://www.technologyreview.com/biotechnology/",
        # Wired Science
        "https://www.wired.com/tag/science/",
        "https://www.wired.com/tag/artificial-intelligence/",
        "https://www.wired.com/tag/climate-change/",
        "https://www.wired.com/tag/space/",
        # Scientific American
        "https://www.scientificamerican.com/",
        "https://www.scientificamerican.com/physics/",
        "https://www.scientificamerican.com/biology/",
        "https://www.scientificamerican.com/earth-environment/",
        "https://www.scientificamerican.com/health/",
        # IEEE
        "https://ieeexplore.ieee.org/",
        "https://www.ieee.org/",
        "https://standards.ieee.org/",
        # ACM
        "https://dl.acm.org/",
        "https://www.acm.org/",
        "https://cacm.acm.org/",
        # PubMed
        "https://pubmed.ncbi.nlm.nih.gov/",
        # Semantic Scholar
        "https://www.semanticscholar.org/",
    ],
    
    # 5. 뉴스 (국제)
    "news-intl": [
        # 뉴스 사이트
        "https://www.nytimes.com/section/technology",
        "https://www.nytimes.com/section/science",
        "https://www.nytimes.com/section/business",
        "https://www.nytimes.com/section/world",
        "https://www.nytimes.com/section/politics",
        "https://www.bbc.com/news/technology",
        "https://www.bbc.com/news/science",
        "https://www.bbc.com/news/business",
        "https://www.bbc.com/news/world",
        "https://www.bbc.com/news/science_and_environment",
        "https://www.theguardian.com/technology",
        "https://www.theguardian.com/science",
        "https://www.theguardian.com/business",
        "https://www.theguardian.com/world",
        "https://www.washingtonpost.com/technology/",
        "https://www.washingtonpost.com/science/",
        "https://www.washingtonpost.com/business/",
        "https://www.reuters.com/technology/",
        "https://www.reuters.com/business/",
        "https://www.reuters.com/world/",
        "https://www.aljazeera.com/technology/",
        "https://www.aljazeera.com/economy/",
        "https://www.aljazeera.com/news/",
        # 기술 뉴스
        "https://techcrunch.com/",
        "https://techcrunch.com/category/artificial-intelligence/",
        "https://techcrunch.com/category/startups/",
        "https://techcrunch.com/category/venture/",
        "https://arstechnica.com/",
        "https://arstechnica.com/ai/",
        "https://arstechnica.com/science/",
        "https://arstechnica.com/gadgets/",
        "https://www.theverge.com/tech",
        "https://www.theverge.com/ai-artificial-intelligence",
        "https://www.theverge.com/science",
        "https://www.wired.com/category/business/",
        "https://www.wired.com/category/security/",
        "https://www.wired.com/category/gear/",
        "https://mashable.com/tech",
        "https://mashable.com/science",
        "https://venturebeat.com/",
        "https://venturebeat.com/ai/",
        "https://venturebeat.com/business/",
        "https://thenextweb.com/",
        "https://thenextweb.com/neural/",
        "https://thenextweb.com/apps/",
        "https://www.engadget.com/",
        "https://www.engadget.com/ai/",
        "https://www.engadget.com/mobile/",
        "https://www.gizmodo.com/",
        "https://www.gizmodo.com/science/",
        "https://www.gizmodo.com/ai/",
        # 비즈니스 뉴스
        "https://www.bloomberg.com/technology",
        "https://www.bloomberg.com/markets",
        "https://www.bloomberg.com/economics",
        "https://www.cnbc.com/technology/",
        "https://www.cnbc.com/world/",
        "https://www.cnbc.com/business/",
        "https://www.ft.com/technology",
        "https://www.ft.com/markets",
        "https://www.wsj.com/tech",
        "https://www.wsj.com/business",
        # 경제 뉴스
        "https://www.economist.com/finance-and-economics",
        "https://www.economist.com/science-and-technology",
        "https://www.economist.com/business",
        "https://www.economist.com/world",
    ],
    
    # 6. 한국 뉴스
    "news-kr": [
        # 경제
        "https://www.mk.co.kr/",
        "https://www.mk.co.kr/news/economy",
        "https://www.mk.co.kr/news/politics",
        "https://www.mk.co.kr/news/stock",
        "https://www.hankyung.com/",
        "https://www.hankyung.com/economy",
        "https://www.hankyung.com/it",
        "https://www.hankyung.com/finance",
        "https://www.ledger.com/",
        "https://www.ledger.com/finance",
        # IT/기술
        "https://www.bloter.net/",
        "https://www.bloter.net/news",
        "https://www.bloter.net/business",
        "https://www.zdnet.co.kr/",
        "https://www.zdnet.co.kr/news",
        "https://www.zdnet.co.kr/view",
        "https://www.itworld.co.kr/",
        "https://www.itworld.co.kr/news",
        "https://www.ciokorea.com/",
        "https://www.ciokorea.com/news",
        # 종합 뉴스
        "https://www.chosun.com/",
        "https://www.chosun.com/nsearch/",
        "https://www.joongang.co.kr/",
        "https://www.joongang.co.kr/economy",
        "https://www.donga.com/",
        "https://www.donga.com/news",
        "https://www.hani.co.kr/",
        "https://www.hani.co.kr/arti/",
        "https://www.khan.co.kr/",
        "https://www.khan.co.kr/politics",
        "https://www.pressian.com/",
        "https://www.ohmynews.com/",
        "https://www.nocutnews.co.kr/",
        "https://www.ytn.co.kr/",
        "https://www.ytn.co.kr/news",
        # 과학
        "https://www.donga.com/news/science",
        "https://www.koreaherald.com/",
        "https://www.koreaherald.com/business",
        "https://www.koreatimes.co.kr/",
        "https://www.koreatimes.co.kr/biz",
    ],
    
    # 7. 교육
    "education": [
        # 온라인 강의
        "https://www.coursera.org/browse/computer-science",
        "https://www.coursera.org/browse/data-science",
        "https://www.coursera.org/browse/math-and-logic",
        "https://www.edx.org/browse/computer-science",
        "https://www.edx.org/browse/data-science",
        "https://www.udemy.com/",
        "https://www.udemy.com/courses/development/",
        "https://www.udemy.com/courses/data-science/",
        "https://www.udemy.com/courses/it-and-software/",
        "https://www.pluralsight.com/browse",
        "https://www.pluralsight.com/browse/software-development",
        "https://www.pluralsight.com/browse/data-professional",
        "https://www.linkedin.com/learning/",
        "https://www.linkedin.com/learning/software-development",
        "https://www.linkedin.com/learning/data-science",
        # 코딩 부트캠프
        "https://www.codecademy.com/catalog",
        "https://www.codecademy.com/learn/paths/web-development",
        "https://www.codecademy.com/learn/paths/data-science",
        "https://www.freecodecamp.org/learn",
        "https://www.freecodecamp.org/learn/responsive-web-design/",
        "https://www.freecodecamp.org/learn/javascript-algorithms-and-data-structures/",
        "https://www.freecodecamp.org/learn/front-end-development-libraries/",
        "https://www.freecodecamp.org/learn/data-visualization/",
        "https://www.freecodecamp.org/learn/back-end-development-and-apis/",
        "https://www.freecodecamp.org/learn/machine-learning-with-python/",
        "https://www.theodinproject.com/",
        "https://www.theodinproject.com/paths/foundations",
        "https://www.theodinproject.com/paths/full-stack-javascript",
        "https://www.theodinproject.com/paths/full-stack-ruby-on-rails",
        "https://www.boot.dev/",
        # 인터뷰 준비
        "https://leetcode.com/",
        "https://leetcode.com/problemset/",
        "https://leetcode.com/studyplan/",
        "https://neetcode.io/",
        "https://neetcode.io/roadmap",
        "https://www.hackerrank.com/domains",
        "https://www.hackerrank.com/domains/algorithms",
        "https://www.hackerrank.com/domains/data-structures",
        "https://www.hackerrank.com/domains/sql",
        "https://www.codeforces.com/",
        "https://www.codeforces.com/problemset",
        "https://www.topcoder.com/",
        "https://www.topcoder.com/challenges",
        # 컴퓨터 사이언스 기초
        "https://cs50.harvard.edu/",
        "https://cs50.harvard.edu/x/",
        "https://cs50.harvard.edu/web/",
        "https://cs50.harvard.edu/ai/",
        "https://cs50.harvard.edu/data/",
        "https://wwwMITopencourseware.mit.edu/",
        "https://ocw.mit.edu/courses/electrical-engineering-and-computer-science/",
        "https://ocw.mit.edu/courses/mathematics/",
        "https://ocw.mit.edu/courses/physics/",
    ],
    
    # 8. 금융/경제
    "finance": [
        # 투자
        "https://www.investopedia.com/",
        "https://www.investopedia.com/financial-term-dictionary-4769738",
        "https://www.investopedia.com/investing-4427685",
        "https://www.investopedia.com/trading-4427714",
        "https://www.investopedia.com/personal-finance-4427736",
        "https://www.investopedia.com/taxes-4427698",
        "https://www.investopedia.com/retirement-4427712",
        "https://www.investopedia.com/markets-4427697",
        # 암호화폐
        "https://www.coinbase.com/",
        "https://www.coinbase.com/learn",
        "https://www.coinbase.com/learn/crypto-basics",
        "https://www.coinbase.com/learn/bitcoin",
        "https://www.coinbase.com/learn/ethereum",
        "https://www.coinbase.com/learn/defi",
        "https://www.coindesk.com/",
        "https://www.coindesk.com/policy/",
        "https://www.coindesk.com/markets/",
        "https://www.coindesk.com/tech/",
        # 경제 데이터
        "https://tradingeconomics.com/",
        "https://tradingeconomics.com/united-states/gdp",
        "https://tradingeconomics.com/united-states/inflation-cpi",
        "https://tradingeconomics.com/united-states/interest-rate",
        "https://tradingeconomics.com/united-states/stock-market",
        "https://www.macrotrends.net/",
        "https://www.macrotrends.net/global-metrics/countries",
        "https://www.macrotrends.net/2013/united-states-gross-domestic-product-gdp",
        # 금융 교육
        "https://www.khanacademy.org/economics-finance-domain",
        "https://www.khanacademy.org/economics-finance-domain/macroeconomics",
        "https://www.khanacademy.org/economics-finance-domain/microeconomics",
        "https://www.khanacademy.org/economics-finance-domain/core-finance",
        "https://www.khanacademy.org/economics-finance-domain/stocks-and-bonds",
        "https://www.khanacademy.org/economics-finance-domain/interest-tutorial",
        # 뉴스
        "https://www.bloomberg.com/markets",
        "https://www.bloomberg.com/economics",
        "https://www.reuters.com/markets/",
        "https://www.reuters.com/business/finance/",
        "https://www.ft.com/markets",
        "https://www.ft.com/companies",
        "https://www.wsj.com/market-data",
        "https://www.cnbc.com/world-markets/",
        "https://www.cnbc.com/economy/",
    ],
    
    # 9. 오픈소스/깃허브
    "opensource": [
        # 인기 프레임워크
        "https://github.com/facebook/react",
        "https://github.com/vuejs/vue",
        "https://github.com/angular/angular",
        "https://github.com/sveltejs/svelte",
        "https://github.com/vercel/next.js",
        "https://github.com/nuxt/nuxt",
        "https://github.com/remix-run/remix",
        "https://github.com/astro-build/astro",
        # 인기 라이브러리
        "https://github.com/lodash/lodash",
        "https://github.com/axios/axios",
        "https://github.com/colinhacks/zod",
        "https://github.com/prisma/prisma",
        "https://github.com/sequelize/sequelize",
        "https://github.com/Automattic/mongoose",
        "https://github.com/knex/knex",
        "https://github.com/trpc/trpc",
        # 상태 관리
        "https://github.com/pmndrs/zustand",
        "https://github.com/reduxjs/redux",
        "https://github.com/TanStack/query",
        "https://github.com/jotaijs/jotai",
        "https://github.com/mobxjs/mobx",
        "https://github.com/reduxjs/rtk",
        # 빌드 도구
        "https://github.com/vitejs/vite",
        "https://github.com/webpack/webpack",
        "https://github.com/rollup/rollup",
        "https://github.com/evanw/esbuild",
        "https://github.com/swc-project/swc",
        "https://github.com/parcel-bundler/parcel",
        # 머신러닝
        "https://github.com/tensorflow/tensorflow",
        "https://github.com/pytorch/pytorch",
        "https://github.com/scikit-learn/scikit-learn",
        "https://github.com/huggingface/transformers",
        "https://github.com/langchain-ai/langchain",
        "https://github.com/openai/openai-python",
        # 데이터베이스
        "https://github.com/prisma/prisma",
        "https://github.com/drizzle-team/drizzle-orm",
        "https://github.com/typeorm/typeorm",
        "https://github.com/kysely-org/kysely",
        # DevOps
        "https://github.com/docker/compose",
        "https://github.com/kubernetes/kubernetes",
        "https://github.com/hashicorp/terraform",
        "https://github.com/ansible/ansible",
        "https://github.com/prometheus/prometheus",
        "https://github.com/grafana/grafana",
        # 모바일
        "https://github.com/facebook/react-native",
        "https://github.com/flutter/flutter",
        "https://github.com/ionic-team/ionic-framework",
        "https://github.com/nicklockwood/SwiftFormat",
        # 유틸리티
        "https://github.com/pallets/click",
        "https://github.com/pallets/flask",
        "https://github.com/encode/fastapi",
        "https://github.com/tiangolo/typer",
        "https://github.com/sqlalchemy/sqlalchemy",
    ],
    
    # 10. 클라우드/인프라
    "cloud-infra": [
        # AWS
        "https://aws.amazon.com/ec2/",
        "https://aws.amazon.com/s3/",
        "https://aws.amazon.com/rds/",
        "https://aws.amazon.com/lambda/",
        "https://aws.amazon.com/api-gateway/",
        "https://aws.amazon.com/cloudfront/",
        "https://aws.amazon.com/vpc/",
        "https://aws.amazon.com/iam/",
        "https://aws.amazon.com/cloudwatch/",
        "https://aws.amazon.com/step-functions/",
        "https://aws.amazon.com/sqs/",
        "https://aws.amazon.com/sns/",
        "https://aws.amazon.com/dynamodb/",
        "https://aws.amazon.com/cognito/",
        # Azure
        "https://azure.microsoft.com/en-us/products/virtual-machines/",
        "https://azure.microsoft.com/en-us/products/storage/",
        "https://azure.microsoft.com/en-us/products/azure-functions/",
        "https://azure.microsoft.com/en-us/products/cosmos-db/",
        "https://azure.microsoft.com/en-us/products/azure-kubernetes-service/",
        "https://azure.microsoft.com/en-us/products/azure-sql/",
        "https://azure.microsoft.com/en-us/products/active-directory/",
        "https://azure.microsoft.com/en-us/products/devops/",
        # GCP
        "https://cloud.google.com/compute",
        "https://cloud.google.com/storage",
        "https://cloud.google.com/functions",
        "https://cloud.google.com/firestore",
        "https://cloud.google.com/kubernetes-engine",
        "https://cloud.google.com/cloud-sql",
        "https://cloud.google.com/bigquery",
        "https://cloud.google.com/pubsub",
        # Cloudflare
        "https://developers.cloudflare.com/workers/",
        "https://developers.cloudflare.com/pages/",
        "https://developers.cloudflare.com/r2/",
        "https://developers.cloudflare.com/d1/",
        "https://developers.cloudflare.com/vectorize/",
        "https://developers.cloudflare.com/ai/",
        "https://developers.cloudflare.com/kv/",
        "https://developers.cloudflare.com/queues/",
        "https://developers.cloudflare.com/turnstile/",
        # Docker
        "https://docs.docker.com/get-started/",
        "https://docs.docker.com/compose/",
        "https://docs.docker.com/engine/",
        "https://docs.docker.com/desktop/",
        "https://docs.docker.com/hub/",
        # Kubernetes
        "https://kubernetes.io/docs/home/",
        "https://kubernetes.io/docs/concepts/",
        "https://kubernetes.io/docs/tasks/",
        "https://kubernetes.io/docs/reference/",
        "https://kubernetes.io/docs/setup/",
        "https://kubernetes.io/docs/tutorials/",
        # CI/CD
        "https://docs.github.com/en/actions",
        "https://docs.github.com/en/actions/quickstart",
        "https://docs.github.com/en/actions/using-workflows",
        "https://docs.github.com/en/actions/using-jobs",
        "https://docs.gitlab.com/ee/ci/",
        "https://docs.gitlab.com/ee/ci/quick_start/",
        "https://www.jenkins.io/doc/",
        "https://www.jenkins.io/doc/pipeline/",
        "https://circleci.com/docs/",
        "https://docs.travis-ci.com/",
    ],
    
    # 11. 데이터 과학/AI
    "data-ai": [
        # 머신러닝
        "https://scikit-learn.org/stable/tutorial/",
        "https://scikit-learn.org/stable/user_guide.html",
        "https://scikit-learn.org/stable/modules/classes.html",
        "https://www.tensorflow.org/tutorials",
        "https://www.tensorflow.org/tutorials/quickstart/beginner",
        "https://www.tensorflow.org/tutorials/quickstart/advanced",
        "https://www.tensorflow.org/tutorials/load_data/",
        "https://www.tensorflow.org/tutorials/estimator/linear",
        "https://pytorch.org/tutorials/",
        "https://pytorch.org/tutorials/beginner/basics/intro.html",
        "https://pytorch.org/tutorials/beginner/basics/tensorqs_tutorial.html",
        "https://pytorch.org/tutorials/beginner/basics/autogradqs_tutorial.html",
        "https://pytorch.org/tutorials/beginner/basics/buildmodel_tutorial.html",
        "https://pytorch.org/tutorials/beginner/basics/data_tutorial.html",
        # 딥러닝
        "https://www.deeplearning.ai/",
        "https://www.deeplearning.ai/courses/",
        "https://www.deeplearning.ai/courses/machine-learning-specialization/",
        "https://www.deeplearning.ai/courses/deep-learning-specialization/",
        "https://www.deeplearning.ai/courses/generative-ai-with-llms/",
        # 자연어 처리
        "https://huggingface.co/docs/transformers/",
        "https://huggingface.co/docs/transformers/main/en/task_summary",
        "https://huggingface.co/docs/tokenizers/",
        "https://huggingface.co/docs/datasets/",
        "https://huggingface.co/docs/evaluate/",
        "https://huggingface.co/docs/peft/",
        # LLM
        "https://platform.openai.com/docs/",
        "https://platform.openai.com/docs/guides/text-generation",
        "https://platform.openai.com/docs/guides/chat-completions",
        "https://platform.openai.com/docs/guides/embeddings",
        "https://platform.openai.com/docs/guides/fine-tuning",
        "https://docs.anthropic.com/",
        "https://docs.anthropic.com/claude/docs/intro-to-claude",
        "https://docs.anthropic.com/claude/docs/build-with-claude",
        # 데이터 분석
        "https://pandas.pydata.org/docs/getting_started/",
        "https://pandas.pydata.org/docs/user_guide/",
        "https://numpy.org/doc/stable/",
        "https://numpy.org/doc/stable/user/quickstart.html",
        "https://matplotlib.org/stable/tutorials/",
        "https://seaborn.pydata.org/tutorial.html",
        "https://plotly.com/python/",
        "https://plotly.com/dash/",
        # 통계
        "https://www.statology.org/",
        "https://www.statology.org/statistics-tutorials/",
        "https://www.statology.org/python-statistics/",
        "https://realpython.com/python-statistics/",
    ],
    
    # 12. 웹 개발 일반
    "web-general": [
        # HTML/CSS
        "https://developer.mozilla.org/en-US/docs/Learn/HTML",
        "https://developer.mozilla.org/en-US/docs/Learn/CSS",
        "https://developer.mozilla.org/en-US/docs/Learn/JavaScript",
        "https://developer.mozilla.org/en-US/docs/Learn/Forms",
        "https://developer.mozilla.org/en-US/docs/Learn/Accessibility",
        "https://www.w3schools.com/html/",
        "https://www.w3schools.com/css/",
        "https://www.w3schools.com/js/",
        "https://www.w3schools.com/sql/",
        "https://www.w3schools.com/python/",
        # API
        "https://restfulapi.net/",
        "https://restfulapi.net/resource-naming/",
        "https://restfulapi.net/http-methods/",
        "https://restfulapi.net/hypermedia/",
        "https://swagger.io/docs/",
        "https://swagger.io/docs/open-source-tools/swagger-editor/",
        "https://swagger.io/docs/open-source-tools/swagger-ui/",
        # 인증
        "https://oauth.net/2/",
        "https://oauth.net/2/grant-types/",
        "https://jwt.io/introduction",
        "https://jwt.io/#debugger-io",
        # 성능
        "https://web.dev/performance/",
        "https://web.dev/fast/",
        "https://web.dev/measure/",
        "https://web.dev/vitals/",
        "https://web.dev/core-web-vitals/",
        # 보안
        "https://owasp.org/www-community/attacks/",
        "https://owasp.org/www-community/attacks/XSS",
        "https://owasp.org/www-community/attacks/SQL_Injection",
        "https://owasp.org/www-community/attacks/CSRF",
        "https://owasp.org/www-community/attacks/Command_Injection",
    ],
}


def generate_dynamic_urls(base_urls: List[str], count_per_base: int = 5) -> List[str]:
    """기본 URL에서 동적 URL을 생성합니다."""
    dynamic_urls = []
    
    # 숫자 패턴 (페이지네이션)
    pagination_patterns = [
        "/page/{i}",
        "/?page={i}",
        "/articles?page={i}",
        "/posts?page={i}",
        "/?offset={i}",
        "/?p={i}",
    ]
    
    # 연도 패턴
    year_patterns = [
        "/{year}/",
        "/archive/{year}/",
        "/blog/{year}/",
        "/news/{year}/",
    ]
    
    # 카테고리 패턴
    category_patterns = [
        "/category/tech",
        "/category/science",
        "/category/business",
        "/category/health",
        "/category/sports",
        "/category/entertainment",
        "/category/politics",
        "/category/world",
    ]
    
    for base in base_urls:
        # 동적 페이지 생성
        for i in range(1, count_per_base + 1):
            pattern = random.choice(pagination_patterns)
            dynamic_urls.append(base.rstrip("/") + pattern.format(i=i))
        
        # 연도별 아카이브
        for year in range(2020, 2027):
            pattern = random.choice(year_patterns)
            dynamic_urls.append(base.rstrip("/") + pattern.format(year=year))
        
        # 카테고리 페이지
        for cat in category_patterns:
            dynamic_urls.append(base.rstrip("/") + cat)
    
    return dynamic_urls


def generate_sitemap_urls(base_url: str, max_pages: int = 100) -> List[str]:
    """사이트맵에서 URL을 추출합니다."""
    urls = []
    
    # 일반적인 사이트맵 경로
    sitemap_paths = [
        "/sitemap.xml",
        "/sitemap_index.xml",
        "/sitemap-1.xml",
        "/sitemap-news.xml",
    ]
    
    for path in sitemap_paths:
        urls.append(base_url.rstrip("/") + path)
    
    return urls


def generate_api_urls(api_bases: List[str]) -> List[str]:
    """API 엔드포인트 URL을 생성합니다."""
    api_urls = []
    
    endpoints = [
        "/api/v1/",
        "/api/v2/",
        "/api/docs",
        "/api/health",
        "/api/status",
        "/swagger.json",
        "/openapi.json",
        "/api-spec.json",
    ]
    
    for base in api_bases:
        for endpoint in endpoints:
            api_urls.append(base.rstrip("/") + endpoint)
    
    return api_urls


def main():
    """메인 함수"""
    print("🚀 10,000+ 시드 URL 생성기")
    print("=" * 50)
    
    all_urls = {}  # 카테고리별 URL
    seen_urls = set()  # 중복 방지
    
    # 1. 기본 시드 URL 추가
    for category, urls in SEED_DATA.items():
        all_urls[category] = []
        for url in urls:
            if url not in seen_urls:
                all_urls[category].append(url)
                seen_urls.add(url)
    
    print(f"\n📊 기본 시드 URL: {len(seen_urls)}개")
    
    # 2. 동적 URL 생성
    print("\n🔄 동적 URL 생성 중...")
    for category, urls in all_urls.items():
        dynamic_urls = generate_dynamic_urls(urls, count_per_base=10)
        for url in dynamic_urls:
            if url not in seen_urls:
                all_urls[category].append(url)
                seen_urls.add(url)
    
    print(f"📊 동적 URL 추가 후: {len(seen_urls)}개")
    
    # 3. 사이트맵 URL 생성
    print("\n🔄 사이트맵 URL 생성 중...")
    base_domains = [
        "https://github.com",
        "https://stackoverflow.com",
        "https://dev.to",
        "https://medium.com",
        "https://hashnode.dev",
        "https://dev.to",
    ]
    
    sitemap_urls = []
    for domain in base_domains:
        sitemap_urls.extend(generate_sitemap_urls(domain))
    
    for url in sitemap_urls:
        if url not in seen_urls:
            all_urls.setdefault("sitemap", []).append(url)
            seen_urls.add(url)
    
    print(f"📊 사이트맵 URL 추가 후: {len(seen_urls)}개")
    
    # 4. 목표 달성을 위한 추가 URL
    print("\n🔄 추가 URL 생성 중...")
    target = 10000
    current = len(seen_urls)
    needed = target - current
    
    if needed > 0:
        # 추가 기술 문서
        additional_tech = [
            "https://dev.to/t/python",
            "https://dev.to/t/javascript",
            "https://dev.to/t/react",
            "https://dev.to/t/node",
            "https://dev.to/t/css",
            "https://dev.to/t/webdev",
            "https://dev.to/t/api",
            "https://dev.to/t/database",
            "https://dev.to/t/devops",
            "https://dev.to/t/machinelearning",
        ]
        
        for base in additional_tech:
            for i in range(1, needed // len(additional_tech) + 2):
                url = f"{base}/page/{i}"
                if url not in seen_urls:
                    all_urls.setdefault("devto", []).append(url)
                    seen_urls.add(url)
                    if len(seen_urls) >= target:
                        break
            if len(seen_urls) >= target:
                break
        
        # 스택오버플로우
        for i in range(1, needed // 3 + 2):
            url = f"https://stackoverflow.com/questions?page={i}"
            if url not in seen_urls:
                all_urls.setdefault("stackoverflow", []).append(url)
                seen_urls.add(url)
                if len(seen_urls) >= target:
                    break
    
    print(f"📊 최종 URL: {len(seen_urls)}개")
    
    # 5. 결과 저장
    output_file = Path("scripts/seed-data/seed-urls-10k.json")
    output_file.parent.mkdir(parents=True, exist_ok=True)
    
    # 카테고리별로 정리
    result = {}
    for category, urls in all_urls.items():
        result[category] = sorted(set(urls))
    
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    
    print(f"\n✅ 결과 저장: {output_file}")
    
    # 6. 통계 출력
    print("\n📊 카테고리별 통계:")
    total = 0
    for category, urls in sorted(result.items()):
        count = len(urls)
        total += count
        print(f"  {category}: {count}개")
    
    print(f"\n📊 총 URL: {total}개")
    
    # 7. 파일 크기 확인
    file_size = output_file.stat().st_size / 1024
    print(f"📊 파일 크기: {file_size:.1f} KB")


if __name__ == "__main__":
    main()
