const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const builderPath = path.resolve(__dirname, '../../marketing/katalogus/build-catalog.mjs');
const baseCatalogPath = path.resolve(__dirname, '../../marketing/katalogus/base-catalog.json');
const hasBuilder = fs.existsSync(builderPath) && fs.existsSync(baseCatalogPath);

test('build-catalog: NAV ÁNYK XML feldolgozás, kurált összevonás és idempotens időbélyeg/SHA-256 kezelés', {
  skip: !hasBuilder ? 'marketing/katalogus nem érhető el' : false,
}, async () => {
  const { parseNavAnykXml, buildCatalog } = await import(pathToFileURL(builderPath).href);

  const sampleXml = `<?xml version="1.0" encoding="utf-8"?>
<nyomtatvanyok>
  <nyomtatvany>
    <rovidnev>2608</rovidnev>
    <szervezet>NAV</szervezet>
    <verzio>2.0</verzio>
    <elnevezes>2608 Havi bevallás a kifizetésekkel, juttatásokkal összefüggő adóról, járulékokról</elnevezes>
  </nyomtatvany>
  <nyomtatvany>
    <rovidnev>26A60</rovidnev>
    <szervezet>NAV</szervezet>
    <verzio>1.0</verzio>
    <elnevezes>26A60 ÖSSZESÍTŐ NYILATKOZAT az Európai Közösség területén belül történő értékesítésekről</elnevezes>
  </nyomtatvany>
  <nyomtatvany>
    <rovidnev>26HIPAK</rovidnev>
    <szervezet>NAV</szervezet>
    <verzio>1.1</verzio>
    <elnevezes>Helyi iparűzési adóbevallás</elnevezes>
  </nyomtatvany>
</nyomtatvanyok>`;

  const parsed = parseNavAnykXml(sampleXml);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].code, '2608');
  assert.equal(parsed[1].code, '26A60');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapumail-cat-test-'));
  try {
    const xmlFile = path.join(tmpDir, 'nav.xml');
    const outDir = path.join(tmpDir, 'out');
    fs.writeFileSync(xmlFile, sampleXml, 'utf8');

    const r1 = await buildCatalog({
      baseFile: baseCatalogPath,
      xmlFile,
      outDir,
      alsoCopy: null,
      minForms: 2,
      force: false,
    });
    assert.equal(r1.changed, true);
    assert.match(r1.sha256, /^[0-9a-f]{64}$/);

    const manifest1 = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    const catalog1 = JSON.parse(fs.readFileSync(path.join(outDir, 'nyomtatvanyok-v1.json'), 'utf8'));
    assert.equal(manifest1.sha256, r1.sha256);
    assert.equal(catalog1.forms['2608'].sent_type, 'nav.beadvany.bevallas');
    assert.equal(catalog1.forms['26HIPAK'].sent_type, 'onk.beadvany');
    assert.equal(catalog1.forms['ASP-ADO-035'].sent_type, 'onk.beadvany');

    // Második futás változatlan XML-lel: nem lépteti az időbélyeget és a hash-t
    const r2 = await buildCatalog({
      baseFile: baseCatalogPath,
      xmlFile,
      outDir,
      alsoCopy: null,
      minForms: 2,
      force: false,
    });
    assert.equal(r2.changed, false);
    assert.equal(r2.updatedAt, r1.updatedAt);
    const manifest2 = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest2.sha256, r1.sha256);
    assert.equal(manifest2.updated_at, r1.updatedAt);

    // Minimum küszöb védelem: ha kevesebb elem jön a küszöbnél, nem írja felül a katalógust
    await assert.rejects(() => buildCatalog({
      baseFile: baseCatalogPath,
      xmlFile,
      outDir,
      alsoCopy: null,
      minForms: 100,
      force: false,
    }), /Túl kevés nyomtatvány/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
