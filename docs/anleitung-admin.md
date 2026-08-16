# Einrichtung: GuniWeb SAP Node mit persönlicher SAP-Anmeldung

*Anleitung für n8n-Administratoren (Deutsch). Ergebnis: Mitarbeiter nutzen SAP in n8n mit ihrer eigenen SAP-Kennung — Berechtigungen und Änderungsbelege in SAP auf der Person, kein geteilter technischer User. Die Anwender-Anleitung: [anleitung-mitarbeiter.md](anleitung-mitarbeiter.md).*

## Überblick

```
n8n (Node „GuniWeb SAP")  ──HTTP, Bearer-Token + SAP-Login der Person──▶  GuniWeb SAP MCP Server  ──OData/IDoc, Basic-Auth als Person──▶  SAP
```

- Der **Server** (`guniweb-sap-mcp`, kostenlos nutzbar) kennt das SAP-System (URL, Mandant) als *Destination* mit `authType: "user-basic"` — ohne SAP-Benutzer.
- Ein **Token** pro Team (oder pro Person) authentisiert n8n am Server, wählt die Destination und begrenzt, was erlaubt ist (z. B. `readOnly`).
- Das **n8n-Credential** jeder Person enthält Server-URL, Token und ihre SAP-Kennung. SAP-Passwörter liegen nur in n8n (verschlüsselt) und reisen je Aufruf mit; der Server speichert sie nicht.

## Voraussetzungen

- GuniWeb SAP MCP Server ≥ 0.4.0 im HTTP-Betrieb, von n8n aus erreichbar (gleiches Docker-Netz oder HTTPS über einen Reverse-Proxy — die SAP-Anmeldung reist als Header, also **TLS oder internes Netz**, nie offen übers Internet).
- n8n self-hosted (Community-Nodes erlaubt, Standard) mit Owner-Rechten. In n8n Cloud sind nur verifizierte Community-Nodes installierbar — Verifizierung ist beantragt/geplant; bis dahin self-hosted.
- SAP: Die Personen brauchen in SAP die Rollen für die OData-Services, die die Workflows nutzen (dieselben wie für Fiori-Apps auf diesen Services). Der Server nutzt ausschließlich SAP-Standardschnittstellen (OData Gateway, IDoc über HTTP) — siehe [Interfaces-Übersicht](https://github.com/guniweb/guniweb-sap-mcp/blob/main/docs/sap-interfaces.md).

## 1. Server: Destination und Token anlegen

Beispiel mit Docker (Compose-Projekt wie in [sap-mcp-ops](https://github.com/guniweb/sap-mcp-ops) — privat; das Muster steht in der [Setup-Anleitung des Servers](https://github.com/guniweb/guniweb-sap-mcp/blob/main/docs/setup-guide.md)):

```bash
# Destination ohne technischen Benutzer: System + Mandant, Anmeldung kommt je Anfrage
docker exec sap-mcp guniweb-sap-mcp destinations add s4prod \
  --base-url https://s4prod.firma.de:44300 --auth-type user-basic --sap-client 100

# Ein Token je Team — lesend zum Start; Schreiben später bewusst freischalten
docker exec sap-mcp guniweb-sap-mcp tokens issue s4prod --label "n8n Vertrieb (read)" --read-only
#   → Klartext-Token EINMAL auf stdout — an die Personen weitergeben (Passwort-Manager, kein Chat)

docker exec sap-mcp guniweb-sap-mcp destinations list
docker exec sap-mcp guniweb-sap-mcp tokens list
```

Dasselbe geht per HTTP über die Admin-API des Servers (`--admin-token`, `PUT /admin/destinations/s4prod`, `POST /admin/tokens`) — praktisch, wenn Zugänge aus einem n8n-Workflow heraus angelegt werden sollen.

**Token pro Team oder pro Person?** Das Token steuert nur *Server*-Rechte (Destination, read-only, Tool-Tiers); *wer* in SAP handelt, entscheidet die SAP-Kennung im Credential. Ein Token pro Team reicht meist; ein Token pro Person lohnt sich, wenn du Zugänge einzeln widerrufen willst (`tokens revoke <label>` wirkt sofort).

**Startlog prüfen:** Für `user-basic`-Destinations meldet der Server beim Start „Selbsttest ohne Benutzer nicht möglich" — das ist richtig so; die erste echte Anfrage mit Login prüft die Verbindung.

## 2. n8n: Node installieren

Self-hosted: **Settings → Community nodes → Install** → Paketname `n8n-nodes-guniweb-sap` → Risiko-Hinweis bestätigen → Install. Danach erscheint „GuniWeb SAP" in der Node-Suche. (Alternativ per Umgebungsvariable beim Start: `N8N_COMMUNITY_PACKAGES=n8n-nodes-guniweb-sap` — je nach n8n-Version; siehe [n8n-Doku](https://docs.n8n.io/integrations/community-nodes/installation/).) Updates: Settings → Community nodes → Update.

Falls Community-Nodes deaktiviert sind: `N8N_COMMUNITY_PACKAGES_ENABLED=true` setzen und n8n neu starten.

## 3. Rollout an die Personen

Jede Person bekommt: Server-URL, Token, den Namen des SAP-Systems — und die [Anwender-Anleitung](anleitung-mitarbeiter.md). Sie legt ihr Credential selbst an (SAP-Passwort tippt nur sie ein) und prüft mit **Discovery → Test Connection**, dass Stufe `auth` **ok** ist.

Checkliste vor dem ersten produktiven Workflow:

- [ ] Server erreichbar aus n8n (`Test Connection` grün mit einer Person)
- [ ] Token `read-only`, solange nur gelesen wird; Schreiben erst mit `--allow-write` am Server **und** einem Token ohne `readOnly` — bewusst und dokumentiert
- [ ] Bei automatischer Beleganlage: SAP-Digital-Access-Frage mit dem SAP-Lizenzverantwortlichen geklärt
- [ ] Personen wissen: Passwortwechsel = Credential aktualisieren; nicht mehrfach mit falschem Passwort probieren (SAP-Sperre)

## 4. Betrieb

- **Wer hat was gemacht?** Jede Tool-Zeile im Server-Log trägt `sapUser` und `correlationId`; in SAP stehen Änderungsbelege auf der Person.
- **Zugang entziehen:** In n8n das Credential der Person löschen (oder SAP-Kennung sperren) — beides wirkt sofort. Team-Token widerrufen: `tokens revoke <label>`.
- **Server-Update:** Node und Server sind lose gekoppelt (Streamable HTTP, `tools/call`); ein Server-Update ändert am Node nichts. Neue Server-Tools sind über **Tool → Call Tool** sofort nutzbar.
- **Fehlerbilder:** 401 „SAP login required" = Credential ohne SAP-Felder an einer `user-basic`-Destination; 400 „nimmt keine persönliche SAP-Anmeldung an" = Credential mit SAP-Feldern an einer Destination mit technischem User (der Server ignoriert das absichtlich nicht still); SAP-401 in `Test Connection` = Passwort falsch/Kennung gesperrt; 403 = SAP-Rolle fehlt (`SU53`).

## Support

Node: [Issues](https://github.com/guniweb/n8n-nodes-guniweb-sap/issues) · Server: [Issues](https://github.com/guniweb/guniweb-sap-mcp/issues) · Kommerziell (SLA, Einführung): [guniweb.de/sap-mcp](https://guniweb.de/sap-mcp), support@guniweb.de
