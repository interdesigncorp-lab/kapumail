<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Határidők naptármeghívóként az ügyfél kapcsolattartójának: ki kér ilyet, és melyik eseményből mi ment már ki. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('client_contacts', function (Blueprint $t) {
            $t->boolean('calendar_invites')->default(false);
        });
        Schema::create('calendar_invites', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('office_id')->index();
            $t->unsignedBigInteger('client_id');
            $t->unsignedBigInteger('contact_id')->index();
            $t->string('item_key', 32);            // m<irat> | o<adónaptár-tétel>
            $t->string('uid', 160);                // a naptáresemény állandó azonosítója
            $t->unsignedInteger('sequence')->default(0);
            $t->date('due_date');
            $t->string('summary', 300);
            $t->string('fingerprint', 64);         // dátum + cím + leírás lenyomata: ebből látszik, változott-e
            $t->string('state', 12)->default('sent'); // sent | cancelled | closed (lejárt, törlő levél nélkül lezárva)
            $t->string('to_email');
            $t->timestamps();
            $t->unique(['contact_id', 'item_key']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('calendar_invites');
        Schema::table('client_contacts', function (Blueprint $t) {
            $t->dropColumn('calendar_invites');
        });
    }
};
