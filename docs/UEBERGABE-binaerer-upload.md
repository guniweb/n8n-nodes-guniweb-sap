# Übergabe: Binärer Upload im GuniWeb-SAP-Knoten

**Angelegt:** 2026-09-07 · **Anlass:** FATH SmartOrder, Phase 13 (automatischer PDF-Anhang am SAP-Auftrag)
**Adressat:** GuniWeb, Weiterentwicklung `n8n-nodes-guniweb-sap` und des MCP-Servers
**Einordnung:** GuniWeb-intern. Gehört **nicht** ins FATH-Jira und **nicht** ins FATH-Confluence.

---

## Worum es geht

Der Knoten kann heute **JSON**. Für SAP-Media-Entities — Anhänge, Belegbilder, alles, was
Rohbytes trägt — reicht das nicht, und SmartOrder musste deshalb in Phase 13 **an ihm vorbei**
gehen.

Gebraucht wird eine Betriebsart, die einen **binären Rumpf** sendet: Dateiname in einer
Kopfzeile, Rohbytes im Body, Antwort als JSON. Konkret der Fall `AttachmentContentSet` in
`API_CV_ATTACHMENT_SRV`.

**Langfristig ist das der sauberere Weg.** Geht alles über denselben Punkt, dann gilt die
Zertifikats-, Sitzungs- und Mandantenbehandlung des Knotens auch für den Anhang — statt dass
jeder Sonderfall sich seine eigene Kette baut.

---

## Was der Umweg heute kostet — am gebauten Beispiel

SmartOrder fährt den Anhang über **HTTP-Request-Knoten** (`n8n/workflows/SO-40-anhang.json`,
gebaut am 2026-09-07). Damit werden vier Dinge wieder scharf, die für die JSON-Wege über den
MCP-Knoten **gegenstandslos** waren:

| Was der MCP-Knoten mitbringt | Was der HTTP-Weg selbst bauen muss |
|---|---|
| Zertifikatskette | **Wurzelzertifikat `Fath-RootCA` als PEM** — eigene n8n-Credential vom Typ *SSL Certificates*, nur das Feld `ca`. Ein Intermediate allein genügt Node und OpenSSL nachweislich nicht (gemessen 2026-07-30) |
| Sitzung / Anmeldung | **CSRF-Vorlauf** mit `X-CSRF-Token: Fetch`, danach Cookie-Weitergabe an den Schreibaufruf. Ein zusätzlicher technischer SAP-Benutzer als Basic-Auth-Credential |
| Mandant | von Hand mitzugeben |
| Fehlerform | eigene Einordnung; SmartOrder brauchte dafür zwei zusätzliche Katalogcodes (`sap_csrf`, `sap_anmeldung`) |

**Betriebliche Folgekosten, die daran hängen:**

- Zwei neue Zugangsdaten, die es bei FATH heute **nicht gibt** — sie blockieren die Abnahme der
  Phase 13 (im FATH-Klärungstrack als `B10`, in Jira an `WE-37` kommentiert).
- Eine Ausnahme im Qualitätsgate des Projekts: `scripts/gates.mjs` meldete bis dahin **jeden**
  HTTP-Request-Knoten an SAP als Fehler — mit gutem Grund, denn der naheliegende Griff bei
  Zertifikatsärger ist „Ignore SSL Issues", und genau das schließt das Abnahmekriterium aus.
  Die Ausnahme ist eng gebaut und auf `SO-40` beschränkt, aber sie ist eine Ausnahme.
- Beim Bauen fiel auf, dass die Knotenreihenfolge des ursprünglichen Plans **nicht laufen kann**:
  Ein HTTP-Request-Knoten reicht eingehende Binärdaten nur in seiner Datei-Form weiter, und der
  CSRF-Vorlauf mit `responseFormat: text` verschluckt das Binärfeld. Solche Fallen entfallen,
  wenn der Rumpf im Knoten bleibt.

---

## Was der Knoten können müsste

**1. Binärer Rumpf beim `create`/`POST` auf eine Media Entity.**
- Quelle: ein Binärfeld des eingehenden Items (n8n-üblich `data`), Feldname konfigurierbar.
- `Content-Type` aus den Binärmetadaten oder ausdrücklich gesetzt.
- **Frei setzbare Kopfzeilen**, mindestens `Slug` — dort steht der Dateiname.
- **Kopfzeilen mit leerem Wert dürfen nicht gesendet werden.** In der gebauten Lösung war eine
  Paarliste dafür untauglich (sie kennt kein Weglassen) und musste durch `jsonHeaders` ersetzt
  werden; „leer heißt: wird nicht gesendet" war nur in dieser Form wahr.

**2. Der Gegenweg: binäre Antwort.** `AttachmentContentSet` hat ein Feld `Content` vom Typ
`Edm.Binary`. Ein Herunterladen des Anhangs sollte als Binärfeld ankommen und nicht als
base64-Zeichenkette im JSON.

**3. `sap_function` hängt am SCHREIBENDEN Zugang — berichtigt am 2026-09-07.**
Die Werkzeugfreigabe des MCP-Servers gilt **je Zugang**, nicht global. Mit `TS4.100 ro`
antwortet der Aufruf `sap_function: MCP error -32602: Tool sap_function disabled`; mit
`TS4.100 wr` läuft er. Der Knoten kann die Operation
(`nodes/GuniwebSap/properties.ts` Z. 42: "Call a V2 function import or a V4 action/function").

**Das ist keine Störung, sondern eine Abwägung mit einem Preis.** `GetAllOriginals` ist ein
LESENDER Aufruf -- der Weg zum Anhangbestand und die Grundlage der Verifikation "zurücklesen
statt Statuscode glauben". Wer ihn braucht, muss heute den schreibenden Zugang nehmen und gibt
damit die Trennung auf, die dieses Projekt bewusst eingefuehrt hat. Ein lesender Funktionsimport
gehörte an den lesenden Zugang.

**Zu erwägen:** Freigabe je Funktion statt je Werkzeug -- `sap_function` ist nicht per se
lesend, ein Funktionsimport kann auch schreiben. Eine grobe Freigabe am lesenden Zugang wäre
deshalb die falsche Abhilfe.

## Was am 2026-09-07 lesend gemessen wurde und für die Umsetzung trägt

Alles über `discovery / getMetadata` auf `/sap/opu/odata/sap/API_CV_ATTACHMENT_SRV/`,
Zugang `TS4.100 ro`, System TS4 Mandant 100. In SAP ist dabei nichts entstanden.

**Die Entitätsmengen des Dienstes:**

| Entitätsmenge | anlegbar | änderbar | löschbar |
|---|---|---|---|
| `AttachmentHarmonizedOperationSet` | ja | **nein** | ja |
| `AttachmentForSAPObjectNodeTypeSet` | ja | **nein** | ja |
| `AttachmentContentSet` | ja | **nein** | ja |
| `SAPObjectDocumentTypeSet` | nein | nein | nein |

**`updatable: 0` über den ganzen Dienst — es gibt kein `PATCH`.** Ein zweiter Upload ersetzt
nichts, er hängt ein zweites Dokument an dasselbe Objekt. Jede Bauform, die „nochmal senden"
anbietet, muss deshalb vorher nachsehen.

**`AttachmentContent` führt 31 Felder**, nicht die acht der Dokumentation (SAP-KBA 3648499).
Für einen Knoten, der Anhänge verwaltet, sind diese hier die interessanten:

| Feld | Typ | Länge |
|---|---|---|
| `FileName` | `Edm.String` | 255 |
| `FileSize` | `Edm.String` | 12 |
| `MimeType` | `Edm.String` | 128 |
| `Content` | `Edm.Binary` | — |
| `CreationDateTime` / `ChangedDateTime` | `Edm.DateTime` | — |
| `CreatedByUser` / `CreatedByUserFullName` | `Edm.String` | 12 / 80 |
| `AttachmentContentHash` | `Edm.String` | 255 |
| `AttachmentDeletionIsAllowed` | `Edm.Boolean` | — |
| `AttachmentRenameIsAllowed` | `Edm.Boolean` | — |
| `DocumentURL` | `Edm.String` | 4096 |
| `LinkedSAPObjectKey` | `Edm.String` | 90 |

**Und am 2026-09-07 zusätzlich gemessen, welche Felder GEFÜLLT ankommen** — über
`GetAllOriginals` mit `TS4.100 wr` an einem echten Anhang:

*Gefüllt:* `FileName`, `FileSize`, `MimeType` (`application/pdf`), `CreationDateTime`,
`CreatedByUser`, `CreatedByUserFullName`, `StorageCategory`, `AttachmentDeletionIsAllowed`
(`True`), `AttachmentRenameIsAllowed` (`False`), `Source`/`HarmonizedDocumentType`/
`DocumentInfoRecordDocType` (je `GOS`).

*Leer, obwohl deklariert:* **`AttachmentContentHash`**, `DocumentURL`, `Content`,
`ChangedDateTime`, `LastChangedByUser`, `SAPObjectType`, `SAPObjectNodeType`.

**Der Hash ist die Lehre daraus:** Er ist mit 255 Zeichen deklariert und kommt leer an. Wer nur
die Metadaten liest, baut auf ein leeres Feld. Für einen Knoten heißt das: die deklarierte
Feldliste taugt zur Typisierung, nicht als Zusicherung über den Inhalt.

**Der Anhang ging über GOS ein**, nicht über klassisches DMS — relevant für die Frage, welche
Bauform der Upload im Knoten anbieten soll. Und `LinkedSAPObjectKey` kommt **zeichengleich**
zurück, ohne stille Normalisierung.

**Die Aufrufform des schreibenden Wegs** (aus einem geglückten Versuch vom 2026-08-17,
dokumentiert in Jira `WE-25`): Kopfzeilen `Slug` (Dateiname), `Content-Type: application/pdf`,
`BusinessObjectTypeName`, `LinkedSAPObjectKey`, `X-CSRF-Token`, `DocumentInfoRecordDocType: PDF`;
Rumpf die Rohbytes. **Beim POST sind es Kopfzeilen, beim lesenden Aufruf Abfrageparameter** —
die Verwechslung erzeugt in beiden Richtungen eine Meldung, die nach fehlender Berechtigung
aussieht und keine ist.

**Der Objekttyp ist `BUS2032`**, am geglückten Versuch abgelesen und nicht abgeleitet.

**Eine Fundstelle für die Fehlerbehandlung:** SAP-KBA 3421507 nennt für die Meldung
*„User has no authorization for operation 03 on object …"* **zwei** Ursachen — den falsch
formatierten Objektschlüssel **und** einen falschen `BusinessObjectTypeName`. Ein Knoten, der
diese Meldung einordnet, sollte beide nennen; sonst sucht der Anwender an der falschen Stelle.
Der Schlüssel geht **zehnstellig mit führenden Nullen** hinaus.

---

## Warum sich der Aufwand lohnt

Der Anhang ist nicht der letzte Fall dieser Art. Jede SAP-Media-Entity — Belegbilder,
Archivdokumente, Anlagen an Lieferungen und Rechnungen — hat dieselbe Form. Wer sie einmal im
Knoten löst, löst sie für alle; wer sie je Projekt über HTTP-Knoten baut, baut jedes Mal
Zertifikatskette, CSRF-Vorlauf und Fehlereinordnung neu — und jedes Mal etwas anders.

Für SmartOrder selbst wäre der Gewinn konkret: `SO-40` fiele auf die Bauform von `SO-20`/`SO-30`
zurück, die Gate-Ausnahme entfiele, und zwei der drei offenen Abnahmeblocker der Phase 13
(`B10`: Wurzelzertifikat und technischer Benutzer) wären gegenstandslos.

---

## Nicht Teil dieser Übergabe

- Die Entscheidung, ob und wann. Das ist GuniWeb-Planung.
- Die FATH-Seite: `SO-40` ist gebaut, ausgeliefert wird abgeschaltet, und die Umstellung auf
  einen künftigen Knoten wäre ein eigener Vorgang mit eigenem Nachweis.
