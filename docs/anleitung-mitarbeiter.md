# SAP in n8n nutzen — mit deiner eigenen SAP-Anmeldung

*Anleitung für Anwenderinnen und Anwender (Deutsch). Für die Einrichtung des Servers und die Installation des Nodes siehe [anleitung-admin.md](anleitung-admin.md).*

Mit dem Node **GuniWeb SAP** liest und schreibst du SAP-Daten (S/4HANA oder ECC) direkt in einem n8n-Workflow — Schritt für Schritt, ohne KI-Agent, so wie du auch eine Datenbank oder eine API ansprichst. Du arbeitest dabei **mit deiner eigenen SAP-Kennung**: SAP prüft deine Berechtigungen, und was du änderst, steht in SAP unter deinem Namen — wie in der SAP GUI.

## Was du brauchst

Von deinem n8n-Administrator bekommst du drei Dinge:

| | Beispiel |
|---|---|
| **Server-URL** des GuniWeb SAP MCP Servers | `http://sap-mcp:8808` oder `https://sap-mcp.firma.de` |
| **Zugangs-Token** (Bearer) — wählt das SAP-System und die erlaubten Operationen | `gsm_s4prod_…` |
| Den Namen des SAP-Systems/Mandanten, den das Token anspricht | `S4P Mandant 100` |

Dazu deine **eigene SAP-Kennung** (Benutzer + Passwort), mit der du dich sonst in SAP anmeldest.

## 1. Credential anlegen (einmalig, 2 Minuten)

1. In n8n links **Credentials** → **Add credential** → nach **„GuniWeb SAP MCP Server API"** suchen.
2. Felder ausfüllen:
   - **Server URL**: die URL vom Administrator.
   - **Access Token**: das Token vom Administrator.
   - **SAP User**: dein SAP-Benutzer (z. B. `MUELLER`).
   - **SAP Password**: dein SAP-Passwort.
   - **Request Timeout**: bleibt auf 120000.
3. **Save** — n8n prüft sofort, ob Server-URL und Token stimmen. Ein grüner Haken heißt: Server erreichbar, Token gültig, SAP-Anmeldung wurde mitgeschickt.

Dein SAP-Passwort wird verschlüsselt in n8n gespeichert und bei jedem Aufruf **nur für diesen Aufruf** an den Server gegeben. Der Server speichert es nicht.

Ob SAP dein Passwort annimmt, siehst du im nächsten Schritt.

## 2. Erster Workflow: Verbindung prüfen und Daten lesen

1. Neuen Workflow anlegen, Node **„GuniWeb SAP"** hinzufügen (in der Node-Suche „SAP" eintippen).
2. **Credential** auswählen (das aus Schritt 1).
3. **Resource: Discovery → Operation: Test Connection** → **Test step**. Du bekommst eine Liste von Stufen (`dns`, `tls`, `auth`, `client`, `catalog`). Steht bei `auth` **ok**, hat SAP deine Anmeldung akzeptiert.
4. Zweiten Node **GuniWeb SAP** anhängen: **Resource: OData → Operation: Query**
   - **Service URL**: `/sap/opu/odata/sap/API_BUSINESS_PARTNER` (oder der Service, den du brauchst — **Discovery → Discover Services** zeigt dir, was es gibt)
   - **Entity Set**: `A_BusinessPartner`
   - **Query Options → Filter**: `Country eq 'DE'`, **Top**: `20`
   - **Test step** → jede Zeile ist ein eigenes Item, mit dem du weiterarbeitest (Filter, Tabellen, E-Mail, …).

Weitere Operationen (Read, Create, Update, Delete, Function, IDoc …) und Beispiele: [README](../README.md#operations).

## 3. Wenn etwas nicht klappt

| Meldung | Bedeutung | Was tun |
|---|---|---|
| *The SAP MCP Server rejected the token (401)* | Token falsch, abgelaufen oder widerrufen | Token im Credential prüfen; neues Token vom Administrator |
| *This SAP destination requires your personal SAP login (401)* | SAP-Benutzer/-Passwort fehlen im Credential | Beide Felder ausfüllen und speichern |
| *Test Connection*: Stufe `auth` **failed**, „401 … Anmeldung fehlgeschlagen" | SAP lehnt deine Anmeldung ab | Passwort prüfen (SAP GUI). **Nicht mehrfach probieren** — SAP sperrt die Kennung nach wenigen Fehlversuchen; dann hilft nur die SAP-Basis |
| Fehler mit **403** / „Keine Berechtigung" | Deine SAP-Kennung darf diesen Service oder diese Aktion nicht | Wie in der GUI: Berechtigung über die SAP-Basis beantragen (Transaktion `SU53` zeigt, was fehlt) |
| Fehler *Tool sap_create disabled* / Operation nicht verfügbar | Schreiben ist für dein Token oder den Server nicht freigegeben | Absichtlich — Freigabe beim Administrator anfragen |
| *Cannot reach the SAP MCP Server* | Server-URL falsch oder Server nicht erreichbar | URL prüfen, Administrator informieren |

**SAP-Passwort geändert?** Credential öffnen, neues Passwort eintragen, speichern — fertig. Bis dahin schlagen deine Workflows mit „Anmeldung fehlgeschlagen" fehl; deaktiviere aktive Workflows lieber kurz, sonst läuft deine Kennung in die Sperre.

## 4. Spielregeln

- Das Credential ist **persönlich** — nicht teilen, nicht in Workflows „für alle" verwenden. Wer einen Workflow für andere baut, nutzt sein eigenes Credential nur, wenn er auch in SAP für diese Aktionen einstehen kann; sonst legt jeder ein eigenes an.
- **Schreiben** (Create/Update/Delete/Function/IDoc) ist bewusst gesondert freigeschaltet. Bevor ein Workflow Belege anlegt: kurz mit dem Administrator und dem SAP-Verantwortlichen abstimmen.
- Alles, was der Workflow tut, steht in SAP unter deinem Namen — genau wie in der GUI. Das ist gewollt.
