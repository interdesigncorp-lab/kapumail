<?php

// A tárhelyműveletek joghatás-besorolása. Minden változtatás jogi felülvizsgálatot igényel
// (lásd docs/adr/ADR-004-joghatas-kapuk.md); a tests/Feature/GuardTest.php őrzi.
return [
    'policy_version' => 'átvétel v2',
    // A szerződési feltételek (resources/legal) alapértelmezett, telepítőbe csomagolt verziója.
    // Emelésekor minden felhasználónak újra el kell fogadnia (TermsController).
    // Az éles indulásig NEM emeljük a jogi szövegek javításakor: csak az élesítéskor egyszer, utána csak érdemi
    // változásnál. A pontos elfogadott szöveget a terms_acceptances.hashes lenyomata verzióemelés nélkül is bizonyítja.
    'terms_version' => '1.4 (2026-11-13)',
    // A hivatalos jogi szövegek élő jegyzéke (kapumail.hu). Ha elérhető és újabb/módosított szöveget tartalmaz,
    // a program letölti (SHA-256 ellenőrzéssel) és helyben gyorsítótárazza; offline módban a csomagolt szöveg marad.
    // Nyílt forráskódú saját fordításnál üresre állítható (IRATKAPU_TERMS_URL="").
    'terms_remote_url' => env('IRATKAPU_TERMS_URL', 'https://kapumail.hu/jogi/manifest.json'),
    'terms_sync_ttl' => (int) env('IRATKAPU_TERMS_SYNC_TTL', 3600),
    // A hivatalos nyomtatvány- és beadványtípus-katalógus élő jegyzéke (kapumail.hu).
    // Szinkronizáláskor ellenőrzi az időbélyeget és a SHA-256 lenyomatot; ha módosult, letölti az új JSON-t és helyben gyorsítótárazza.
    // Offline módban vagy IRATKAPU_CATALOG_URL="" beállítással a telepítőbe csomagolt alapkatalógus működik.
    'catalog_remote_url' => env('IRATKAPU_CATALOG_URL', 'https://kapumail.hu/katalogus/manifest.json'),
    'catalog_sync_ttl' => (int) env('IRATKAPU_CATALOG_SYNC_TTL', 3600),
    // Hivatalos, digitálisan aláírt kiadás-e (true = 14 napos próbaidő + előfizetési licenckapu; false = nyílt forráskódú AGPLv3 saját fordítás korlát nélkül).
    'official_build' => env('IRATKAPU_OFFICIAL_BUILD') !== null
        ? filter_var(env('IRATKAPU_OFFICIAL_BUILD'), FILTER_VALIDATE_BOOLEAN)
        : is_file(dirname(__DIR__).'/bootstrap/official-build.json'),
    'trial_days' => max(1, (int) env('IRATKAPU_TRIAL_DAYS', 14)),
    'subscribe_url' => env('IRATKAPU_SUBSCRIBE_URL', 'https://kapumail.hu/#elofizetes'),
    'github_url' => env('IRATKAPU_GITHUB_URL', 'https://kapumail.hu/open-source'),
    // A billing-szerver (próba és szakmai MCP-token): POST /api/billing/mcp/trial és /api/billing/mcp/token.
    'billing_url' => env('IRATKAPU_BILLING_URL', 'https://kapumail.hu'),
    // ECDSA P-256 nyilvános kulcs az előfizetési licenckulcsok (KM1.<payload>.<sig>) helyi, offline ellenőrzéséhez.
    'license_public_key' => env('IRATKAPU_LICENSE_PUBLIC_KEY', "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEgMu1BYmLjVmAXFHP1jIofEaoV4ef\ntETpQK2XmtZnURdq6d/J5BxAqOO1HNIIl662d1ooa91UK+k5R9M+8BeLzg==\n-----END PUBLIC KEY-----"),
    'license_private_key' => env('IRATKAPU_LICENSE_PRIVATE_KEY'),
    // demo: beépített minta-csatlakozó, valódi tárhely nélkül. live: nincs megvalósítva, minden művelet BLOKKOLT.
    'mode' => env('IRATKAPU_MODE', 'demo'),
    // Jelszó nélküli helyi fiók a helyi módú asztali alkalmazásnak (egy gép, egy fiók; csak a saját gépről hívható).
    // Közös, interneten elérhető szerveren kapcsold KI.
    'local_account' => (bool) env('IRATKAPU_LOCAL_ACCOUNT', true),
    // Élő LISTÁZÁS a tarhely-cli-vel, az asztali appból. Alapból KI.
    // Bekapcsolása tulajdonosi döntés: a listázás joghatása nincs bizonyítva (ADR-004, ADR-007).
    // Csak ember indíthatja, csak a saját gépén, a saját azonosítójával. Letöltést ez NEM engedélyez.
    // Naptármeghívó csak az ennyi napon belüli határidőkről megy ki, hogy a bekapcsoláskor ne induljon levéláradat.
    'invite_horizon_days' => (int) env('IRATKAPU_INVITE_HORIZON_DAYS', 60),
    'live_listing' => (bool) env('IRATKAPU_LIVE_LISTING', false),
    // Élő LETÖLTÉS az asztali alkalmazásból: gombnyomásra egyedi küldeményre, illetve az iroda
    // kifejezett szabálybeállítása szerint (joghatás nélküli nyugtákra vagy felülíró szabállyal).
    'live_download' => (bool) env('IRATKAPU_LIVE_DOWNLOAD', false),
    // Élő ELKÜLDÖTT mappa szinkronizálása az asztali alkalmazásból. Alapból KI (ADR-008: élő próba igazolásáig).
    'live_sent' => (bool) env('IRATKAPU_LIVE_SENT', false),
    // NAV ügyfélportál, „B kör”: KÉPVISELET-VÁLTÁS az ügyfelek adatainak kiolvasásához. Alapból KI.
    // A váltás módosító kérés a NAV felé (a munkamenet kiválasztott adózóját állítja át), ezért bekapcsolása tulajdonosi
    // döntés (ADR-010). Bekapcsolva a program a belépő által képviselt, az irodában ügyfélként felvett, aktív adózókra
    // vált át egyenként, és a futás végén visszavált a belépő saját profiljára.
    'nav_switch' => (bool) env('IRATKAPU_NAV_SWITCH', false),
    // NAV ügyfélportál, „C kör”: a BEADOTT BEVALLÁSOK lekérdezése. Alapból KI. Olvasó lekérdezés, de a NAV oldalán
    // lekérdezést hoz létre (POST), ezért bekapcsolása tulajdonosi döntés (ADR-010).
    'nav_queries' => (bool) env('IRATKAPU_NAV_QUERIES', false),
    // NAV ügyfélportál, letölthető kimutatások (adószámla PDF/XLSX, törzsadat PDF, biztosítottak XLSX). Alapból KI.
    // Kérésre, ügyfelenként fut; az adószámla- és a biztosítotti lekérdezés a NAV oldalán lekérdezést hoz létre (ADR-010).
    'nav_exports' => (bool) env('IRATKAPU_NAV_EXPORTS', false),
    // Az adózónak menő levelek (továbbítás, hátralék, fizetési emlékeztető) csak akkor mehetnek, ha az irodának van saját SMTP-je,
    // vagy a szerver alapértelmezett levelezője ismerten jó. Éles környezetben alapból KI.
    'default_mailer_ok' => (bool) env('IRATKAPU_DEFAULT_MAILER_OK', false),
    'operations' => [
        'listAccounts' => ['effect' => 'unknown',  'approval' => false, 'auto' => true,  'live' => 'NEM BIZONYÍTOTT', 'evidence' => 'research/R01 – író hívás nincs, szerveroldali hatás nincs igazolva'],
        'listMessages' => ['effect' => 'unknown',  'approval' => false, 'auto' => true,  'live' => 'NEM BIZONYÍTOTT', 'evidence' => 'research/R01, R03 – élő próba és üzemeltetői válasz kell'],
        'getMetadata' => ['effect' => 'unknown',  'approval' => true,  'auto' => false, 'live' => 'NEM BIZONYÍTOTT', 'evidence' => 'research/R01 – részlet lekérés hatása ismeretlen'],
        'getReceipt' => ['effect' => 'unknown',  'approval' => true,  'auto' => false, 'live' => 'NEM BIZONYÍTOTT', 'evidence' => 'research/R03'],
        'download' => ['effect' => 'possible', 'approval' => true,  'auto' => false, 'live' => 'BLOKKOLT',        'evidence' => 'research/R01 AGENTS.md:46 – a letöltés jogi hatása nincs tisztázva'],
        'moveToDurable' => ['effect' => 'unknown',  'approval' => true,  'auto' => false, 'live' => 'BLOKKOLT',        'evidence' => 'research/R01 – a kliens nem hívja, a portál viselkedése ismeretlen'],
        'delete' => ['effect' => 'certain',  'approval' => true,  'auto' => false, 'live' => 'TILTOTT',         'evidence' => 'specifikáció 3. (E) – MVP-ben tiltott'],
        'send' => ['effect' => 'certain',  'approval' => true,  'auto' => false, 'live' => 'TILTOTT',         'evidence' => 'specifikáció 3. (E) – MVP-ben tiltott'],
    ],
    // Mintaszabály a demóhoz. NEM hiteles határidőszabály: minden ebből számolt dátum „becsült”.
    'demo_deadline_days' => ['nav-hianypotlas' => 8, 'nav-felszolitas' => 8, 'nav-hatarozat' => 15, 'cegbirosag-vegzes' => 8],
    // Szövegfelismerés szkennelt iratokra a gépre telepített tesseract / pdftoppm programmal. Alapból KI:
    // idegen eredetű fájlt külső programmal dolgoz fel, és a felismert szöveg tévedhet.
    'ocr' => ['enabled' => (bool) env('IRATKAPU_OCR', false), 'max_pages' => 3, 'timeout' => 20, 'max_docs' => 5, 'max_seconds' => 60, 'tesseract' => env('IRATKAPU_TESSERACT'), 'pdftoppm' => env('IRATKAPU_PDFTOPPM')],
    'es3' => ['max_file' => 20 * 1024 * 1024, 'max_docs' => 200, 'max_decoded' => 80 * 1024 * 1024, 'max_depth' => 3],
];
