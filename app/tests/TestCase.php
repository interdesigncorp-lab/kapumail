<?php

namespace Tests;

use Illuminate\Foundation\Testing\TestCase as BaseTestCase;

abstract class TestCase extends BaseTestCase
{
    protected function setUp(): void { parent::setUp(); \App\Iratkapu\TypeSettings::flush(); } // a statikus gyorsítótár ne szivárogjon át tesztek között
}
