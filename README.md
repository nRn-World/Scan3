# Scan3 — LagerScan (Videoinventering till Excel)

Webbapp för snabb inventering av **Delivery**- och **Removal**-paket genom att **filma alla etiketter och streckkoder i en sammanhängande video** i stället för att fotografera paket ett och ett. När videon stängs skapas en färdigkategoriserad **Excel-fil (`.xlsx`)**.

---

## Funktioner

- **Filma live eller ladda upp video:** Använd mobilkameran direkt i webbläsaren eller ladda upp en redan inspelad videofil (`.mp4`, `.mov`, `.webm`).
- **Läser både streckkod och text:** Kombinerar 1D/2D-streckkodsläsning (`Code128`, `QR`, m.fl.) och optisk textavläsning (`OCR`).
- **Automatisk kund- och typkategorisering:**
  - `Del...` / `DLV...` → **Delivery**
  - `Rem...` / `RMV...` / `RET...` → **Removal**
  - Läser av kundnamnet på etiketten (t.ex. `Microsoft` + `Del001234567` → `Kund: Microsoft | Kategori: Delivery | Nummer: Del001234567`) och ignorerar transportörer som `DHL`, `UPS`, `PostNord` och `DB Schenker`.
- **Smart dubbletträkning (`Antal: 2`):**
  - Låser på aktuell låda så att samma låda aldrig dubbelräknas medan du filmar den.
  - Räknar automatiskt `+1` när kameran flyttas vidare till nästa fysiska paket med likadant nummer och sparar **bildbevis (urklippt foto + tidpunkt)** för varje inräknad låda.
- **Granskning & Excel-export (`.xlsx`):**
  - Redigera kund, kategori, nummer eller antal vid behov och exportera direkt till en formaterad `.xlsx`-fil (`Kund | Kategori | Nummer | Antal` + `SUM`-rad).

---

## Snabbstart på mobilen (GitHub Pages med HTTPS)

Mappen `docs/` innehåller en färdig fristående version av appen (`docs/index.html`):

1. Gå till **Settings → Pages** i detta GitHub-repo (`nRn-World/Scan3`).
2. Välj **Source: Deploy from a branch** → Branch **`main`** och mapp **`/docs`** → klicka **Save**.
3. Öppna `https://nrn-world.github.io/Scan3/` i mobilens webbläsare för att filma direkt med bakre kameran via HTTPS!

*(Du kan även öppna `LagerScan_App.html` direkt i valfri webbläsare utan server.)*

---

## Kör fullstack-versionen lokalt (Python PP-OCRv4 + ZXing-CPP + React)

### 1. Installera och starta backend + webbserver (port 8000)

```bash
pip install -r requirements.txt
./start.sh
```

Öppna sedan `http://localhost:8000` i webbläsaren.

### 2. Utveckla och bygg om frontend (valfritt)

```bash
npm install
npm run build
```
