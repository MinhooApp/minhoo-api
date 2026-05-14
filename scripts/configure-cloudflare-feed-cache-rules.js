#!/usr/bin/env node

/* eslint-disable no-console */
const path = require("path");
const dotenv = require("dotenv");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

const ROOT_DIR = path.resolve(__dirname, "..");
const API_BASE = "https://api.cloudflare.com/client/v4";
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const toPositiveInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const FEED_RULES = [
  {
    ref: "minhoo_post_summary_cache_v1",
    description: "Minhoo: cache post summary feed",
    expression:
      '(http.request.method eq "GET" or http.request.method eq "HEAD") and (http.request.uri.path eq "/api/v1/post" or http.request.uri.path eq "/api/v1/post/suggested") and http.request.uri.query contains "summary=1" and not any(http.request.headers.names[*] in {"authorization" "cookie"}) and not http.request.uri.query contains "urlToken=" and not http.request.uri.query contains "auth_token=" and not http.request.uri.query contains "authToken=" and not http.request.uri.query contains "token="',
  },
  {
    ref: "minhoo_reel_summary_cache_v1",
    description: "Minhoo: cache reel summary feed",
    expression:
      '(http.request.method eq "GET" or http.request.method eq "HEAD") and (http.request.uri.path eq "/api/v1/reel" or http.request.uri.path eq "/api/v1/reel/suggested") and http.request.uri.query contains "summary=1" and not any(http.request.headers.names[*] in {"authorization" "cookie"}) and not http.request.uri.query contains "urlToken=" and not http.request.uri.query contains "auth_token=" and not http.request.uri.query contains "authToken=" and not http.request.uri.query contains "token="',
  },
  {
    ref: "minhoo_bootstrap_home_cache_v1",
    description: "Minhoo: cache bootstrap home for public requests",
    expression:
      '(http.request.method eq "GET" or http.request.method eq "HEAD") and http.request.uri.path eq "/api/v1/bootstrap/home" and not any(http.request.headers.names[*] in {"authorization" "cookie"}) and not http.request.uri.query contains "urlToken=" and not http.request.uri.query contains "auth_token=" and not http.request.uri.query contains "authToken=" and not http.request.uri.query contains "token="',
    edgeTtlSeconds: 60,
  },
];

const loadEnv = () => {
  dotenv.config();
  const envFile = String(process.env.ENV_FILE || "").trim();
  if (envFile) {
    dotenv.config({
      path: path.resolve(ROOT_DIR, envFile),
      override: true,
    });
  }
  applyFileBackedSecrets(process.env, {
    forceOverride: false,
    baseDir: ROOT_DIR,
  });
};

const normalizeHostname = (value) =>
  String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();

const toLikelyZoneName = (hostnameRaw) => {
  const hostname = normalizeHostname(hostnameRaw);
  if (!hostname) return "";
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length < 2) return hostname;
  return labels.slice(-2).join(".");
};

const buildCloudflareError = (status, payload, fallback) => {
  const messages = Array.isArray(payload?.errors)
    ? payload.errors
        .map((err) => String(err?.message || "").trim())
        .filter(Boolean)
    : [];
  const details = messages.length > 0 ? messages.join("; ") : fallback;
  return `Cloudflare API error (${status}): ${details}`;
};

const requestCloudflare = async (apiToken, method, pathname, body) => {
  const response = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return { ok: response.ok, status: response.status, payload };
};

const ensureZoneId = async ({ apiToken, zoneId, zoneName }) => {
  if (zoneId) return zoneId;
  if (!zoneName) return "";

  const lookup = await requestCloudflare(
    apiToken,
    "GET",
    `/zones?name=${encodeURIComponent(zoneName)}&status=active&per_page=1`
  );
  if (!lookup.ok || !lookup.payload?.success) {
    throw new Error(
      buildCloudflareError(lookup.status, lookup.payload, "failed to resolve zone id")
    );
  }

  return String(lookup.payload?.result?.[0]?.id || "").trim();
};

const getEntrypointRuleset = async ({ apiToken, zoneId }) => {
  const response = await requestCloudflare(
    apiToken,
    "GET",
    `/zones/${encodeURIComponent(zoneId)}/rulesets/phases/http_request_cache_settings/entrypoint`
  );

  if (response.status === 404) return null;
  if (!response.ok || !response.payload?.success) {
    throw new Error(
      buildCloudflareError(
        response.status,
        response.payload,
        "failed to fetch cache settings entrypoint ruleset"
      )
    );
  }
  return response.payload.result || null;
};

const createEntrypointRuleset = async ({ apiToken, zoneId, initialRulePayload }) => {
  const response = await requestCloudflare(
    apiToken,
    "POST",
    `/zones/${encodeURIComponent(zoneId)}/rulesets`,
    {
      name: "default",
      kind: "zone",
      phase: "http_request_cache_settings",
      rules: [initialRulePayload],
    }
  );

  if (!response.ok || !response.payload?.success) {
    throw new Error(
      buildCloudflareError(
        response.status,
        response.payload,
        "failed to create cache settings ruleset"
      )
    );
  }
  return response.payload.result || null;
};

const buildRulePayload = (rule) => {
  const feedEdgeTtlMode = String(
    process.env.CLOUDFLARE_FEED_EDGE_TTL_MODE || "override_origin"
  )
    .trim()
    .toLowerCase();
  const feedEdgeTtlSeconds = Math.max(
    30,
    toPositiveInt(process.env.CLOUDFLARE_FEED_EDGE_TTL_SECONDS, 90)
  );
  const edgeTtl =
    feedEdgeTtlMode === "respect_origin"
      ? { mode: "respect_origin" }
      : {
          mode: "override_origin",
          default: Math.max(30, toPositiveInt(rule?.edgeTtlSeconds, feedEdgeTtlSeconds)),
        };
  return {
    action: "set_cache_settings",
    ref: rule.ref,
    description: rule.description,
    enabled: true,
    expression: rule.expression,
    action_parameters: {
      cache: true,
      edge_ttl: edgeTtl,
      browser_ttl: { mode: "respect_origin" },
    },
  };
};

const upsertOneRule = async ({ apiToken, zoneId, rulesetId, existingRules, ruleDef }) => {
  const payload = buildRulePayload(ruleDef);
  const existing = (existingRules || []).find(
    (rule) =>
      String(rule?.ref || "").trim() === ruleDef.ref ||
      String(rule?.description || "").trim() === ruleDef.description
  );

  if (!existing?.id) {
    const created = await requestCloudflare(
      apiToken,
      "POST",
      `/zones/${encodeURIComponent(zoneId)}/rulesets/${encodeURIComponent(rulesetId)}/rules`,
      payload
    );
    if (!created.ok || !created.payload?.success) {
      throw new Error(
        buildCloudflareError(created.status, created.payload, `failed to create ${ruleDef.ref}`)
      );
    }
    return {
      ref: ruleDef.ref,
      operation: "created",
      rule_id: created.payload?.result?.id || null,
    };
  }

  const updatePath = `/zones/${encodeURIComponent(zoneId)}/rulesets/${encodeURIComponent(
    rulesetId
  )}/rules/${encodeURIComponent(existing.id)}`;
  let updated = await requestCloudflare(apiToken, "PATCH", updatePath, payload);
  if (!updated.ok) {
    updated = await requestCloudflare(apiToken, "PUT", updatePath, payload);
  }

  if (!updated.ok || !updated.payload?.success) {
    throw new Error(
      buildCloudflareError(updated.status, updated.payload, `failed to update ${ruleDef.ref}`)
    );
  }

  return {
    ref: ruleDef.ref,
    operation: "updated",
    rule_id: updated.payload?.result?.id || existing.id,
  };
};

const main = async () => {
  loadEnv();

  const apiToken = String(
    process.env.CLOUDFLARE_CACHE_API_TOKEN ||
      process.env.CLOUDFLARE_API_TOKEN ||
      process.env.CLOUDFLARE_MEDIA_API_TOKEN ||
      ""
  ).trim();
  let zoneId = String(process.env.CLOUDFLARE_ZONE_ID || "").trim();
  const apiBaseUrl = String(process.env.API_BASE_URL || "").trim();
  const zoneName =
    String(process.env.CLOUDFLARE_ZONE_NAME || "").trim() ||
    toLikelyZoneName(apiBaseUrl);

  if (!apiToken) {
    throw new Error(
      "Missing Cloudflare token. Set CLOUDFLARE_CACHE_API_TOKEN (or CLOUDFLARE_API_TOKEN)."
    );
  }

  if (dryRun) {
    const dryZoneId = zoneId || (zoneName ? `<resolve-from:${zoneName}>` : null);
    console.log(
      JSON.stringify(
        {
          dry_run: true,
          zone_id: dryZoneId,
          zone_name: zoneName || null,
          rules: FEED_RULES.map((rule) => buildRulePayload(rule)),
        },
        null,
        2
      )
    );
    return;
  }

  zoneId = await ensureZoneId({ apiToken, zoneId, zoneName });
  if (!zoneId) {
    throw new Error(
      "Missing Cloudflare zone id. Set CLOUDFLARE_ZONE_ID or CLOUDFLARE_ZONE_NAME."
    );
  }

  let ruleset = await getEntrypointRuleset({ apiToken, zoneId });
  let bootstrap = "none";
  if (!ruleset) {
    ruleset = await createEntrypointRuleset({
      apiToken,
      zoneId,
      initialRulePayload: buildRulePayload(FEED_RULES[0]),
    });
    bootstrap = "created_entrypoint_ruleset";
  }

  let liveRules = Array.isArray(ruleset?.rules) ? ruleset.rules : [];
  const results = [];

  for (const ruleDef of FEED_RULES) {
    const result = await upsertOneRule({
      apiToken,
      zoneId,
      rulesetId: ruleset.id,
      existingRules: liveRules,
      ruleDef,
    });
    results.push(result);

    // Refresh live rules after each mutation so next upsert can detect the newly created rule.
    const refreshed = await getEntrypointRuleset({ apiToken, zoneId });
    if (refreshed?.id) {
      ruleset = refreshed;
      liveRules = Array.isArray(refreshed.rules) ? refreshed.rules : [];
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        zone_id: zoneId,
        zone_name: zoneName || null,
        ruleset_id: ruleset?.id || null,
        bootstrap,
        rules: results,
      },
      null,
      2
    )
  );
};

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
});
