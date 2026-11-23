<p align="center">
  <img src="docs/images/segretario-mmg.svg" alt="Segretario MMG — Referti e prescrizioni, con meno passaggi" width="100%">
</p>

<p align="center">
  Un assistente per i medici che usano <strong>Eumed</strong>.<br>
  Legge referti e liste di esami e ti aiuta a compilare il gestionale, sotto il tuo controllo.
</p>

<p align="center">
  <a href="https://github.com/1702micky/segretariommg/releases/download/v0.16.29/SegretarioMMG-Setup-0.16.29.exe"><strong>↓ Scarica per Windows</strong></a>
  &nbsp; · &nbsp;
  <a href="#inizia-in-quattro-passaggi">Come si installa</a>
  &nbsp; · &nbsp;
  <a href="#domande-frequenti">Domande frequenti</a>
</p>

<p align="center">Windows 64 bit · Google Chrome · IA sul tuo computer</p>

> **Versione pilota 0.16.29.** Prima dell’uso abituale, prova il programma e controlla i risultati in Eumed. Il programma di installazione non è ancora firmato digitalmente.

## Cosa puoi fare

| Se vuoi… | Scegli questa modalità |
|---|---|
| Inserire i risultati di esami già presenti nel gestionale | **Referto già prescritto** — compila le righe esistenti. |
| Registrare un referto senza una prescrizione pregressa | **Referto non prescritto** — crea le righe per gli esami riconosciuti. |
| Preparare una prescrizione da un elenco | **Prescrivi esami da lista** — legge testo, PDF e foto, anche con X e spunte. |

Puoi incollare il testo o caricare un **PDF, un JPEG o un PNG**. Gli esami vengono confrontati con il catalogo di laboratorio; le voci non associate con certezza vengono segnalate per la verifica.

## Uno sguardo al programma

![Anteprima illustrativa della schermata iniziale: scelta del modello IA e delle tre modalità](docs/images/schermata-iniziale.svg)

*Anteprima illustrativa ricostruita dai testi dell’interfaccia attuale. Non contiene dati di pazienti e non è uno screenshot della pagina Eumed.*

### Dal documento al gestionale

**1. Scegli l’attività** → **2. Carica o incolla il documento** → **3. Analizza e verifica** → **4. Inserisci in Eumed**

Gli esami semplici possono essere inseriti come valori numerici; quelli composti, come emocromo e urine, vengono gestiti come referti estesi. Per i documenti difficili puoi usare la lettura con IA.

Per **Referto non prescritto**, un testo composto solo da righe come `glicemia 91 mg/dL`, `creatinina sierica 0,82 mg/dL` o `FT4 15 pmol/L` può essere letto direttamente, senza IA. Sono gestiti diversi esami del sangue comuni, inclusi transaminasi, lipidi, elettroliti e ormoni, con nome univoco e unità compatibile. Se una riga non è interpretabile con certezza, resta il normale percorso di analisi. Urine, raccolte delle 24 ore e referti composti mantengono la loro gestione specifica. Date e intervalli mancanti non vengono inventati.

Sono riconosciuti anche i referti con **ES. EMOCROMOCITOMETRICO** in italiano e **CHIMICA CLINICA**, con risultati sulla stessa riga del nome. L'emocromo viene mantenuto completo; “P-COLESTEROLO” viene distinto da HDL, LDL e non-HDL. L'IA usa campi espliciti e le proposte vengono confrontate con il testo sorgente: non deve aggiungere sezioni assenti né interpretare note generali come condizioni del paziente. La diagnostica indica quanti elementi sono stati accettati o scartati, senza riportarne il contenuto.

**Controlla sempre l’anteprima, le voci segnalate e il risultato finale.** Durante l’inserimento tieni Eumed in primo piano e non lavorare contemporaneamente sugli stessi campi.

## Inizia in quattro passaggi

### 1 · Scarica e avvia il setup

[**Scarica Segretario MMG per Windows**](https://github.com/1702micky/segretariommg/releases/download/v0.16.29/SegretarioMMG-Setup-0.16.29.exe)

Salva i lavori aperti in Chrome e chiudi gli eventuali lavori IA in corso. Il primo avviso del setup spiega che **premendo OK Chrome verrà chiuso automaticamente**, anche in background, per il tuo account: i dati non salvati potrebbero andare persi. Annullando, Chrome resta aperto. Non riaprirlo fino al messaggio finale. I download possono richiedere anche un'ora o più. Avvia il file e autorizza la richiesta di Windows. Usa lo stesso account amministratore con cui lavori in Chrome.

La finestra di installazione mostra **fase in corso, tempo trascorso, MB e barra di avanzamento**. Durante le attese mostra un indicatore animato. La percentuale si riferisce al singolo download, non al tempo totale rimasto. Ollama viene avviato in background, senza aprire la chat durante il primo avvio gestito dal setup.

Il programma viene installato in **`C:\AI\segretario-mmg-extension`**: mantieni questa cartella nello stesso posto.

Durante il download di Ollama e degli aggiornamenti vedi i **MB scaricati** e, se il server comunica il totale, una **barra di avanzamento con percentuale**. Se il totale non e disponibile, vengono mostrati i MB ricevuti. Il modello IA mantiene la barra di download di Ollama.

### 2 · Scegli il modello IA

Il setup mostra la RAM disponibile e propone un modello. Puoi cambiare la scelta:

| Computer | Modello proposto |
|---|---|
| Meno di circa 12 GB di RAM | **Qwen3-VL 2B**, più leggero |
| Da circa 12 GB di RAM | **Qwen3.5 4B**, il modello di riferimento del progetto |

La RAM è un’indicazione, non una garanzia di velocità. Servono Internet per i download e almeno **12 GB liberi su C:**. Il setup prepara Ollama, PDF e OCR e verifica i componenti; non devi installare Node o Python.

Se hai già un modello, scegli **Non scaricare un modello IA: ne ho già uno installato**. Il setup salta il download e la prova del modello; potrai selezionarlo nella schermata iniziale dell'estensione. Gli altri componenti vengono comunque configurati e verificati.

### 3 · Aggiungi l’estensione a Chrome

Al termine del setup segui queste istruzioni, necessarie **solo la prima volta**:

1. Digita **`chrome://extensions`** nella barra degli indirizzi di Chrome.
2. Attiva **Modalità sviluppatore**.
3. Premi **Carica estensione non pacchettizzata**.
4. Seleziona **`C:\AI\segretario-mmg-extension`**.

Se avevi una vecchia copia di Segretario MMG, disattivala prima di aggiungere questa: non lasciare due copie attive.

**Aprire la pagina delle estensioni:** il setup apre questa pagina automaticamente al termine dell'installazione. In alternativa copia questo indirizzo con il pulsante di copia del riquadro e incollalo nella barra degli indirizzi:

```text
chrome://extensions
```

Chrome non permette di aprire gli indirizzi `chrome://` da un collegamento in una pagina web. Puoi anche usare il menu **⋮ → Estensioni → Gestisci estensioni**.

### 4 · Apri Eumed

Apri la sezione corretta, premi il pulsante **MMG** e scegli l’attività:

| Attività | Dove andare in Eumed |
|---|---|
| Referto già prescritto | **Registrazione esiti → Inserimento da prescrizioni** |
| Referto non prescritto | **Registrazione esiti → Inserimento senza prescrizioni** |
| Prescrivi esami da lista | **Accertamenti**, non Dashboard |

Nella schermata iniziale trovi anche il modello IA: puoi selezionare un altro modello già installato o premere **Aggiorna elenco**.

Se usi **Referto già prescritto** ma alcuni esami riconosciuti con certezza non hanno una riga disponibile in Eumed, compare **Da inserire senza prescrizioni** con **Copia blocco**. Copialo, apri **Registrazione esiti → Inserimento senza prescrizioni**, scegli **Referto non prescritto** e incollalo nel campo del referto. Analizza e controlla l'anteprima prima di inserire. Il blocco conserva data, valori, unità, intervalli disponibili e referti complessi, viene rivalidato senza IA e non è incluso nel report diagnostico. Contiene risultati del referto: usalo solo nel paziente corretto e non allegarlo a segnalazioni pubbliche.

Per la prima prova usa una breve lista di esami e controlla l’anteprima prima di inserire i dati.

### Dove trovo il pulsante MMG? Posso spostarlo?

![Pulsante MMG: premi per aprire, trascina per spostare](docs/images/pulsante-mmg.svg)

Nella pagina di Eumed compare il pulsante scuro **MMG**, inizialmente in alto a destra. **Un clic apre il pannello** di Segretario MMG.

Per spostarlo, **tieni premuto il tasto sinistro sul pulsante, trascinalo nella posizione che preferisci e rilascia**. Puoi così evitare che copra un campo o un comando di Eumed. La posizione viene ricordata nel profilo Chrome.

Quando il pannello è aperto, puoi spostarlo trascinando la sua **barra superiore “SEGRETARIO MMG”**. L’immagine è illustrativa e riproduce l’aspetto del pulsante, senza dati reali.

La diagnostica della prescrizione da lista registra anche i passaggi della selezione: tentativo, proposte visibili, verifica del campo, uso del Tab, conferma locale e verifica della nuova riga. Le righe sono identificate da un numero progressivo; nomi degli esami, codici e contenuto dei campi non vengono inclusi. Il file contiene una legenda per interpretare questi stati.

Nella prescrizione da lista, una riga già presente blocca il reinserimento come duplicato solo quando **Data presc. è quella di oggi**. Le prescrizioni vecchie non impediscono un nuovo inserimento; la data dell'esito non viene usata per questo controllo. Se la colonna o la data non sono leggibili, il programma chiede una verifica esplicita. La selezione riconosce anche le proposte che mostrano solo il nome dopo una ricerca per codice, ma esclude quelle con un codice diverso.

I codici citati nelle note **Incluso / Non associabile** non vengono confusi con il codice della proposta. Sono riconosciute anche diciture abbreviate come **Emogruppo** e **HBcAb**. Le richieste accorpate nel reflex HBV restano visibili nell'anteprima, con una nota sulle condizioni di inclusione dell'IgM previste dal catalogo.

## Gli aggiornamenti

Nella schermata iniziale, vicino alla scelta del modello IA, trovi la **versione installata**, lo stato rispetto all'ultima release GitHub e la data dell'ultima verifica. **Verifica aggiornamenti** esegue subito un nuovo controllo. Se è disponibile una nuova versione, **Scarica aggiornamento** scarica il setup: avvialo dopo aver salvato i lavori aperti. Il download da solo non installa l'aggiornamento.

Se lasci attiva l’opzione del setup, il programma cerca nuove versioni all’accesso Windows e ogni ora. Gli aggiornamenti dell’estensione vengono applicati **soltanto quando Chrome è completamente chiuso**; altrimenti vengono rimandati.

Alla riapertura Chrome carica la versione aggiornata. Non devi scaricare manualmente lo ZIP di aggiornamento. Per controllare subito puoi usare il collegamento **Aggiorna-Segretario** creato sul desktop, dopo aver chiuso Chrome.

L’aggiornamento automatico riguarda l’estensione. Modelli IA, Ollama e programma di installazione hanno una gestione separata.

## Come si disinstalla

1. Apri `chrome://extensions` e premi **Rimuovi** sulla scheda di Segretario MMG. Poi chiudi completamente Chrome.
2. Vai in **Impostazioni di Windows → App → App installate**, cerca **Segretario MMG** e scegli **Disinstalla**. Puoi anche cercare **Disinstalla Segretario MMG** nel menu Start.
3. Conferma la richiesta di Windows e quella del programma.

La disinstallazione rimuove i file installati, l'avvio automatico, il controllo aggiornamenti e il collegamento Aggiorna-Segretario. Rimuove dalle impostazioni Ollama l'autorizzazione riservata a questa estensione e ripristina l'indirizzo precedente del servizio, se non lo hai cambiato nel frattempo. Riavvia Ollama o Windows per applicare queste impostazioni.

**Ollama e i modelli IA restano installati**, così puoi usarli con altri programmi. I dati in Eumed non vengono modificati. Log, backup e file aggiunti manualmente sono conservati; il messaggio finale indica dove trovarli.

La voce di disinstallazione viene aggiunta dal **nuovo setup**: se hai già installato una versione precedente, esegui il setup aggiornato. Il solo aggiornamento automatico dell'estensione non aggiunge questa funzione.

## Domande frequenti

<details>
<summary><strong>I referti vengono inviati a un servizio IA online?</strong></summary>

L’analisi IA usa Ollama e i modelli locali sul computer. L’estensione esclude i riferimenti ai modelli cloud. Il download dei componenti e il controllo degli aggiornamenti richiedono Internet; Eumed mantiene il proprio normale funzionamento online.

</details>

<details>
<summary><strong>Devo pagare o avere un account sviluppatore Chrome?</strong></summary>

Il pacchetto qui distribuito non richiede un account sviluppatore Chrome. L’estensione viene aggiunta manualmente dalla cartella locale, con la modalità sviluppatore attiva.

</details>

<details>
<summary><strong>Posso usare un’altra IA?</strong></summary>

Sì. Il selettore mostra i modelli locali presenti in Ollama e ricorda la scelta nel profilo Chrome. Per leggere foto e liste con spunte serve un modello che supporti anche le immagini. I modelli alternativi vanno provati: possono dare risultati e tempi diversi. Il ragionamento esteso è disattivato di default.

</details>

<details>
<summary><strong>Il pannello dice che Ollama non risponde.</strong></summary>

Avvia Ollama sul computer, poi premi **Aggiorna elenco** nella schermata iniziale. Se il problema continua, consulta il log del setup in `%LOCALAPPDATA%\SegretarioMMG`.

</details>

<details>
<summary><strong>Un esame è segnalato come “da verificare”.</strong></summary>

Non è stato associato o interpretato con sufficiente certezza. Controlla il documento originale e la voce del catalogo. Se l’inserimento si interrompe, controlla anche le righe già presenti prima di riprovare: non rilanciare automaticamente l’intero documento.

</details>

<details>
<summary><strong>Come segnalo un problema?</strong></summary>

Apri una [segnalazione su GitHub](https://github.com/1702micky/segretariommg/issues), indicando versione, modalità e passaggi per riprodurre il problema.

1. Nel pannello premi **Scarica report diagnostico (.txt)** e allega il file. È disponibile in tutte e tre le modalità dopo l’elaborazione e contiene tempi, conteggi e stato delle operazioni, senza copiare il testo del referto.
2. **Copia e incolla i dati anonimizzati del referto** utili a riprodurre l’errore: nome dell’esame, valore, unità e intervallo di riferimento, mantenendo le righe vicine quando servono a capire la struttura. Spiega cosa ti aspettavi e cosa è stato inserito.
3. Elimina prima nomi, codice fiscale, data di nascita, indirizzi, numeri di pratica e ogni altro elemento identificativo. Se non puoi anonimizzare con certezza, usa un esempio sintetico.

**Non allegare il PDF originale o schermate con dati personali.** Le segnalazioni di questo repository sono pubbliche. Controlla sempre anche il file diagnostico prima di condividerlo; non viene inviato automaticamente.

</details>

---

[Tutte le versioni](https://github.com/1702micky/segretariommg/releases) · [Guida completa al setup](installer/LEGGIMI-INSTALLER.md) · [Informazioni per sviluppatori](docs/SVILUPPO.md)
