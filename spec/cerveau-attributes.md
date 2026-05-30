# Spécification du vocabulaire `data-cerveau-*`

**Version :** 0.1.0
**Statut :** normatif pour LazyBrain v0.x

Ce document définit les attributs HTML utilisés par LazyBrain pour annoter les notes du brain. Toute violation de cette spec entraîne un rejet à l'écriture par `src/schema/validator.ts`.

## Principes

1. Tous les attributs sont préfixés `data-cerveau-` pour éviter les collisions.
2. Les valeurs sont **toujours des strings** (sérialisables en HTML).
3. Les types complexes utilisent JSON encodé inline.
4. Tout attribut non listé ici est **ignoré silencieusement** mais conservé (forward-compat).
5. Les dates suivent ISO 8601 strict (`YYYY-MM-DD` ou `YYYY-MM-DDTHH:mm:ssZ`).

## Attributs racine (sur `<article>` ou `<section>` top-level d'une note)

| Attribut | Type | Requis | Description |
|---|---|---|---|
| `id` | string | oui | Identifiant unique de la note (slug stable) |
| `data-cerveau-version` | semver | oui | Version du schema utilisée (e.g. `0.1.0`) |
| `data-cerveau-created` | ISO datetime | oui | Date de création |
| `data-cerveau-updated` | ISO datetime | non | Dernière modification |
| `data-cerveau-tier` | enum | non | `working` \| `archival` (défaut `working`) |
| `data-cerveau-type` | enum | non | `episodic` \| `semantic` \| `procedural` \| `decision` \| `reference` |
| `data-cerveau-source` | URI | oui | Source de la note (e.g. `session:abc123#msg42`) |
| `data-cerveau-importance` | float [0,1] | non | Saillance (défaut 0.5) |
| `data-cerveau-last-accessed` | ISO datetime | non | Pour decay |
| `data-cerveau-access-count` | integer | non | Compteur d'accès |
| `data-cerveau-tags` | space-separated | non | Tags libres |
| `data-cerveau-confidence` | float [0,1] | non | Confiance globale dans la note (défaut 1.0) |

## Validity windows (sur `<article>` ou tout élément)

| Attribut | Type | Description |
|---|---|---|
| `data-cerveau-valid-from` | ISO date | Début de validité |
| `data-cerveau-valid-until` | ISO date | Fin de validité (présent = invalidé) |
| `data-cerveau-invalidated-by` | ID ref | ID de la note qui invalide (e.g. `#decision-42`) |
| `data-cerveau-replaces` | ID ref | ID de la note remplacée |
| `data-cerveau-superseded-by` | ID ref | ID de la note successeur |

## Faits inline (sur `<p>`, `<li>`, `<dd>`, ou élément personnalisé)

| Attribut | Type | Description |
|---|---|---|
| `data-cerveau-fact` | boolean attr | Marque l'élément comme fact atomique |
| `data-cerveau-confidence` | float [0,1] | Confiance dans ce fact spécifique |
| `data-cerveau-extracted-by` | string | Méthode d'extraction (`heuristic` \| `llm:claude-opus-4-7` \| `human`) |
| `data-cerveau-source` | URI | Source du fact (override l'article si présent) |

## Relations / liens

Les liens utilisent `<a href>` HTML natif, enrichis par :

| Attribut | Type | Description |
|---|---|---|
| `data-cerveau-link-type` | enum | `refines` \| `contradicts` \| `generalizes` \| `cites` \| `replaces` \| `follows-from` |
| `data-cerveau-link-strength` | float [0,1] | Pondération pour Graph RAG |
| `data-cerveau-link-direction` | enum | `forward` \| `bidirectional` (défaut `forward`) |

## Consolidation / batches

Les `<memory-batch>` (custom element) regroupent des notes compressées :

| Attribut | Type | Description |
|---|---|---|
| `data-cerveau-batch-size` | integer | Nombre de notes consolidées |
| `data-cerveau-batch-period` | string | Période couverte (e.g. `2026-05-13/2026-05-19`) |
| `data-cerveau-consolidated-from` | ID list (csv) | IDs des notes sources |
| `data-cerveau-compression-ratio` | float [0,1] | Taille batch / taille originale |
| `data-cerveau-dreamed-at` | ISO datetime | Timestamp de la consolidation |
| `data-cerveau-dreamer` | string | Modèle utilisé (e.g. `claude-haiku-4-5`) |

## Provenance et audit

Tout élément peut porter :

| Attribut | Type | Description |
|---|---|---|
| `data-cerveau-session-id` | string | Session Claude Code d'origine |
| `data-cerveau-message-id` | string | Message dans la session |
| `data-cerveau-tool` | string | Tool utilisé (Bash, Edit, etc.) si applicable |

## Exemple complet

```html
<article id="auth-decision-12"
         data-cerveau-version="0.1.0"
         data-cerveau-created="2026-05-20T10:15:00Z"
         data-cerveau-type="decision"
         data-cerveau-source="session:abc123#msg42"
         data-cerveau-tier="working"
         data-cerveau-importance="0.9"
         data-cerveau-tags="auth oauth security migration"
         data-cerveau-valid-from="2026-05-20">

  <h2>Migration vers OAuth2 PKCE</h2>

  <p data-cerveau-fact data-cerveau-confidence="1.0" data-cerveau-extracted-by="human">
    Décision : abandonner JWT custom pour OAuth2 PKCE.
  </p>

  <p data-cerveau-fact data-cerveau-confidence="0.8" data-cerveau-extracted-by="llm:claude-opus-4-7">
    Motif principal : audit sécurité Q2 a flaggé la rotation des secrets manuelle.
  </p>

  <ul>
    <li>
      Voir
      <a href="../audit/q2-report.html#section-3"
         data-cerveau-link-type="cites"
         data-cerveau-link-strength="1.0">audit Q2</a>
    </li>
    <li>
      Remplace
      <a href="../2026-01/jwt-impl.html"
         data-cerveau-link-type="replaces">implémentation JWT janvier</a>
    </li>
  </ul>
</article>
```

## Comment ajouter un attribut

1. Documenter ici avec exemple
2. Mettre à jour `src/schema/validator.ts`
3. Bump version mineure du schema (`data-cerveau-version`)
4. Migration script si breaking change

## Réservé pour futures versions

- `data-cerveau-embedding-hash` : checksum de l'embedding pour invalider le cache
- `data-cerveau-graph-cluster` : ID de cluster pour Graph RAG
- `data-cerveau-emotion` : valence pour mémoire émotionnelle (OpenMemory)
