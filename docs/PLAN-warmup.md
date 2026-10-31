# Plan: Warmup durch Claude, weniger Lag, neues Design

Stand 29.10.2026. Grundlage: BRIEF.md (harte Regeln gelten weiter: keine automatischen Likes, Kommentare, Follows, DMs, Profilbesuche).

## Befund im Code

### Warum der Claude-Warmup in der App heute gar nicht läuft
1. `scheduler.js` wird von der App nie gestartet (launcher.sh startet nur server.js).
2. `scroll.js` schreibt Logs nach `ROOT/logs` und liest `scroll.json`/`.env` aus `ROOT`. In der App ist ROOT `/Applications/phone-lab.app/Contents/Resources/app` (wird beim Update ersetzt), richtig wäre `PHONELAB_DATA`.
3. `scroll.js` braucht `@anthropic-ai/sdk`, das Paket ist nicht im App-Bundle ("Node-Server ohne Zusatzpakete").
4. Server und Scroll-Sitzung wissen nichts voneinander: eine VA kann mitten in eine Claude-Sitzung tippen, die Kachel zeigt das nicht.
5. Bewertung je Reel mit `claude-opus-5-5`: teuer und langsam für eine Ja/Nein-Frage.

### Lag
1. Kein Befehls-Takt je Handy: Taps, Wische und Auto-Scroll gehen parallel an dieselbe WDA-Sitzung, stauen sich in XCTest und kommen verspätet an.
2. `health()` fragt alle 10 s Status UND Akku per WDA ab, auch während jemand bedient. Das blockiert den XCTest-Hauptthread.
3. Alle Kacheln streamen dauernd, auch unsichtbare (außerhalb des Bildschirms, hinter der Focus-Ansicht). Über Tailscale kostet das die meiste Bandbreite.
4. `broadcast()` baut jedes Bild je Zuschauer neu zusammen, der Parser hängt je Datenstück per `Buffer.concat` an.
5. `/me` (alle 30 s je Nutzer) liest und parst das komplette `zugriff.log`, das unbegrenzt wächst.

## Bausteine

### 1 Warmup-Plan je Account
- `settings.json` bekommt `warmup[phoneId] = { start: "2026-10-30", niche, days: [...] }`.
- Vorlage 14 Tage (vom Admin änderbar): Tag 1-3 nur scrollen, ab Tag 4 wenige Likes/Kommentare durch die VA, ab Tag 8 erster Post (über Metricool, nicht hier).
- Je Tag: Scroll-Minuten (Claude), Likes und Kommentare (VA), Post ja/nein.

### 2 Scroll-Sitzungen durch Claude
- Scheduler wandert in den Server (kein zweiter Prozess), liest die Scroll-Minuten aus dem Warmup-Plan.
- Sitzung belegt das Handy sichtbar als "Claude" (Sperre wie bei VAs), VA-Eingriff stoppt die Sitzung sofort.
- Nischen-Bewertung per `claude-haiku-5-5` über `fetch` (kein SDK nötig), Key aus `PHONELAB_DATA/.env`.
- Logs nach `PHONELAB_DATA/logs/scroll.jsonl`.
- Wischverhalten bleibt wie es ist (schon variiert), wird nicht weiter auf "unentdeckbar" getrimmt.

### 3 Aufgabenliste für die VA
- Kachel zeigt je Handy den Warmup-Tag und was heute offen ist ("Tag 5: 6/8 Likes, 1/2 Kommentare").
- Zählt aus den vorhandenen Befehlen (doubletap = Like, text/keys = Kommentar) je Handy, nicht je Nutzer.

### 4 Gesundheits-Wächter
- Prüft in Claude-Sitzungen UND bei VA-Bedienung (alle 60 s, nur wenn das Handy aktiv ist) den Bildschirmtext auf die Stoppwörter.
- Treffer: Handy für heute pausiert, roter Hinweis auf der Kachel, Eintrag im Protokoll, optional macOS-Mitteilung.

### 5 Lag
- Befehls-Warteschlange je Handy; veraltete Auto-Wische werden verworfen statt gestaut.
- Akku nur alle 60 s und nie während Bedienung, Status-Check nur wenn 10 s kein Befehl lief.
- Kacheln außerhalb des Sichtfelds und hinter der Focus-Ansicht pausieren ihren Stream (IntersectionObserver).
- `broadcast()` baut das Bild einmal, Parser ohne wiederholtes `concat`.
- `insights()` wird gecacht (neu berechnen nur bei geänderter Log-Datei).

### 6 Design
- Taste-Skill (App-Screens-Modus) + 21st als Vorlage, Umsetzung in reinem HTML/CSS wie bisher (kein Build-Schritt, kein Framework).
- Kachel-Raster, Focus-Ansicht, Warmup-Fortschritt, Login, Modals.

## Test
- Auf Windows: Server mit Fake-WDA (Stub für /status, /actions, MJPEG) starten, Dashboard per Browser prüfen, `scroll.js --dry`.
- Auf dem Mac mit echtem Handy: nur der User. Am Ende jeder Phase anhalten.
- Kein Push ohne Go.
