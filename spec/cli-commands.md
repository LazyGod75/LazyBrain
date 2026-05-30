# LazyBrain CLI — référence des commandes

Toutes les commandes lisent `LAZYBRAIN_BRAIN_PATH` (env var) pour localiser le brain.

## Format de sortie

Par défaut : JSON sur stdout. Options :
- `--strip` : texte stripé prêt pour LLM (sans balises HTML)
- `--pretty` : sortie humaine lisible
- `--json` : JSON explicite (défaut)

## Commandes core (lecture)

### `lazybrain search <query>`
Recherche full-text + sémantique adaptative (router L1→L5).
- `--top <n>` (default 5)
- `--mode <l1|l2|l3|l4|auto>` (default auto)
- `--strip` (text only)
- `--diversity <0-1>` MMR lambda

### `lazybrain query <css-selector>`
Query CSS selector déterministe (L1, &lt; 5ms).
- `--attribute <name>` : extraire un attribut spécifique
- `--strip`

### `lazybrain inject-context`
Génère le contexte à injecter au SessionStart.
- `--max-tokens <n>` (default 3000)
- `--prefer-recent` : weight recency
- `--strip` (default true)

### `lazybrain stats`
Affiche métriques live (notes, latence p50, distribution router).

## Commandes core (écriture)

### `lazybrain store`
Stocke une nouvelle note. Lit du HTML depuis stdin ou option.
- `--from-stdin` (default)
- `--from-file <path>`
- `--type <decision|reference|episodic|semantic|procedural>`
- `--tags <space-separated>`
- `--source <uri>`
- Retourne l'ID créé.

### `lazybrain link <from-id> <to-id>`
Crée un lien bidirectionnel.
- `--type <refines|contradicts|generalizes|cites|replaces|follows-from>`
- `--strength <0-1>`

### `lazybrain invalidate <id>`
Marque une note ou un fait comme invalidé (`data-cerveau-valid-until`).
- `--replaced-by <id>`
- `--reason <text>`

## Commandes système (appelées par hooks)

### `lazybrain capture`
Capture une session (transcript → HTML annoté).
- `--from-stdin` : transcript brut
- `--async` : queue + return immédiat (PostToolUse)
- `--flush-sync` : flush queue synchrone (PreCompact)
- `--session <id>` : session ID Claude Code

### `lazybrain compress [--session <id>]`
Consolidation de notes éphémères en `<memory-batch>`.
- Appelé par hook Stop ou cron quotidien.

### `lazybrain index-rebuild`
Rebuild SQLite FTS5 et structural index depuis le HTML.
- À lancer après git pull.

## Commandes publication

### `lazybrain publish`
Publie une copie scrubée vers GitHub Pages.
- `--dry-run` (défaut) : montre le diff
- `--confirm` : push effectif
- `--exclude-tier <archival>` : ne publier que working
- Refuse si secrets détectés.

### `lazybrain serve`
Serveur HTTP local optionnel (read-only).
- `--port <n>` (default 4242)
- `--token <auth-token>` : authentification basique
- Pour partage temporaire LAN.

## Codes de sortie

- `0` : succès
- `1` : erreur générique
- `2` : argument invalide
- `3` : brain path introuvable
- `4` : schema invalide (à l'écriture)
- `5` : conflit (ID existant en store sans `--overwrite`)
- `6` : publication refusée (secret détecté)

## Variables d'environnement

| Var | Description | Défaut |
|---|---|---|
| `LAZYBRAIN_BRAIN_PATH` | Path du brain (dossier `brain/`) | requis |
| `LAZYBRAIN_CACHE_PATH` | Cache (SQLite, embeddings) | `$BRAIN_PATH/../_cache` |
| `LAZYBRAIN_MODELS_PATH` | Modèles ONNX téléchargés | `~/.lazybrain/models` |
| `LAZYBRAIN_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` | `info` |
| `LAZYBRAIN_TELEMETRY` | Enable telemetry JSONL | `1` |
