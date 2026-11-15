<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/** A Kapu-chat felületének fájljai (/ui/…): csak bejelentkezve, csak a felsorolt fájlok (ADR-014). */
class KapuFeluletTest extends TestCase
{
    use RefreshDatabase;

    protected bool $seed = true;

    private function u(string $k): User
    {
        return User::where('initials', $k)->firstOrFail();
    }

    public function test_a_kapu_fajljai_csak_bejelentkezve_erhetok_el(): void
    {
        $this->get('/ui/kapu.js')->assertRedirect('/login');

        $r = $this->actingAs($this->u('LG'))->get('/ui/kapu.js')->assertOk();
        $this->assertStringStartsWith('application/javascript', $r->headers->get('Content-Type'));
        $this->assertStringContainsString('no-store', $r->headers->get('Cache-Control'));
        $this->assertStringContainsString('KapuView', $r->getContent());

        $css = $this->get('/ui/kapu.css')->assertOk();
        $this->assertStringStartsWith('text/css', $css->headers->get('Content-Type'));
        $this->get('/ui/kapu-md.js')->assertOk();
        $this->get('/ui/kapu-typing.js')->assertOk();
    }

    public function test_ismeretlen_fajl_404(): void
    {
        $this->actingAs($this->u('LG'));
        $this->get('/ui/app.html')->assertNotFound();
        $this->get('/ui/package.json')->assertNotFound();
        $this->get('/ui/nincs.js')->assertNotFound();
    }

    public function test_konyvtarbol_kilepes_404(): void
    {
        $this->actingAs($this->u('LG'));
        $this->get('/ui/../ui/app.html')->assertNotFound();
        $this->get('/ui/..%2Fapp.html')->assertNotFound();
        $this->get('/ui/%2E%2E%2F.env')->assertNotFound();
    }
}
