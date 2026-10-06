# ukkosutka
Personal use lighning tracker. 

## ⛈️ Myrskyn tallennus demoon

Parhaat ukkoset tallennetaan staattisiksi tiedostoiksi `storms/`-kansioon,
josta "▶ Myrsky" -nappi toistaa ne kartalla (n. 90 s). FMI:tä ei tarvita toistoon.

Omalla koneella (Node 18+), repon juuressa:

```
npm run something-something-storm
```

Kysyy alun, lopun ja nimen (Suomen aikaa, esim. `2026-07-30 21:00` → `02:00`).
Sitten: `git add storms && git commit -m "Myrsky" && git push`.

Lepotila ja muu backend: `worker/fmi-lightning-worker.js` (deploy kopioimalla dashboardiin).
