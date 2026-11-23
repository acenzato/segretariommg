Segretario MMG 0.16.29

- Codice dell'estensione suddiviso in moduli (src/engine, src/extension, src/standalone); segretario.js e generato da npm run build e non e piu versionato.
- Nuovo strumento tools/eval.mjs: esegue l'analisi dei referti PDF testuali senza Chrome, browser o Eumed, nel formato di dataset_format.md, e calcola i punteggi.
- Nessun cambiamento di comportamento nell'estensione.
- Test Node superati, inclusi i nuovi test sul caso sintetico.
