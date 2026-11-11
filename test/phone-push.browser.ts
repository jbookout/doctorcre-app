import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";

test("phone push controls at phone and desktop sizes in both themes", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir("out/test-artifacts/phone-push", { recursive: true });
  for (const width of [390, 1440])
    for (const theme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
      try {
        await page.route("**/push-test.html", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/system.css"><link rel="stylesheet" href="/css/notifications.css"></head><body><main id="test" class="shell"></main></body></html>',
          }),
        );
        await page.goto(`${server.origin}/push-test.html`);
        await page.evaluate(async (theme) => {
          document.documentElement.dataset.theme = theme;
          const { mountPhonePush } = await import("/js/ui-phone-push.generated.js");
          const root = document.querySelector("#test");
          if (!root) throw Error("Missing test host");
          const calls: string[] = [];
          const view = mountPhonePush(root, {
            installation: "11111111-1111-4111-8111-111111111111",
            supported: () => true,
            permission: () => "granted",
            requestPermission: async () => {
              calls.push("permission");
              return "granted";
            },
            subscribe: async () => ({
              endpoint: "https://web.push.apple.com/synthetic",
              p256dh: "synthetic",
              auth: "synthetic",
            }),
            unsubscribe: async () => {
              calls.push("unsubscribe");
              return true;
            },
            call: async (verb, args) => {
              calls.push(verb);
              return {
                ok: true,
                schema_version: "web-push-registry.v1",
                replayed: false,
                installation_id: args.installation_id,
                generation: verb.startsWith("register") ? 1 : 2,
                state: verb.startsWith("register") ? "active" : "revoked",
              };
            },
            changed() {},
          });
          Reflect.set(window, "pushCalls", calls);
          Reflect.set(window, "pushView", view);
        }, theme);
        assert.equal(await page.evaluate(() => Reflect.get(window, "pushCalls").length), 0);
        await page.getByRole("button", { name: "Enable phone notifications" }).click();
        await page.getByRole("button", { name: "Disable phone notifications" }).waitFor();
        assert.match((await page.getByRole("status").textContent()) ?? "", /enabled on this installation/);
        await page.screenshot({ path: `out/test-artifacts/phone-push/${width}-${theme}.png` });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.getByRole("button", { name: "Disable phone notifications" }).click();
        await page.getByRole("button", { name: "Enable phone notifications" }).waitFor();
        const calls: unknown = await page.evaluate(() => Reflect.get(window, "pushCalls"));
        assert.deepEqual(calls, [
          "permission",
          "register-web-push-subscription-v1",
          "revoke-web-push-subscription-v1",
          "unsubscribe",
        ]);
        await page.evaluate(() => Reflect.get(window, "pushView").retire());
        await page.getByText("Session ended. Sign in again to manage this installation.").waitFor();
        assert.equal(await page.getByRole("button").isDisabled(), true);
      } finally {
        await page.close();
      }
    }
});

test("real phone push startup reads authenticated configuration and stops on disabled outcomes", async (t) => {
  const config = JSON.parse(await readFile(new URL("./fixtures/phone-push/config.json", import.meta.url), "utf8"));
  const { Ajv2020: Ajv } = await import("ajv/dist/2020.js");
  const schema = JSON.parse(
    await readFile(new URL("../contracts/carr-interface.v1/web-push-config.v1.json", import.meta.url), "utf8"),
  );
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(schema);
  const registrySchema = JSON.parse(
    await readFile(new URL("../contracts/carr-interface.v1/web-push-registry.v1.json", import.meta.url), "utf8"),
  );
  ajv.addFormat("uuid", /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  const validateRegistry = ajv.compile(registrySchema);
  assert.equal(validate(config), true);
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const [outcome, payload, structured, expected] of [
    ["configured", config, false, "Phone notifications are off on this installation."],
    ["structured", config, true, "Phone notifications are off on this installation."],
    [
      "absent",
      { error: "push_not_configured" },
      false,
      "Phone notifications are unavailable until the public notification key is configured.",
    ],
    [
      "invalid",
      { error: "push_config_invalid" },
      false,
      "Phone notifications are unavailable because the public notification configuration is invalid.",
    ],
    [
      "wrong schema",
      { ...config, schema_version: "web-push-config.v2" },
      false,
      "Phone notifications are unavailable because the public notification configuration is invalid.",
    ],
    ["unavailable", { ...config }, false, "Sign in and reconnect to manage phone notifications."],
    ["retired", { ...config }, false, "Session ended. Sign in again to manage this installation."],
  ] as const) {
    await t.test(outcome, async () => {
      const page = await browser.newPage();
      try {
        const calls: string[] = [];
        const paths: string[] = [];
        page.on("request", (request) => paths.push(new URL(request.url()).pathname));
        await page.addInitScript(() => {
          Object.defineProperty(Notification, "permission", { value: "granted" });
          Notification.requestPermission = async () => "granted";
          navigator.serviceWorker.register = async () => navigator.serviceWorker.ready;
          Object.defineProperty(navigator.serviceWorker, "ready", {
            value: Promise.resolve({
              pushManager: {
                getSubscription: async () => null,
                subscribe: async (options: PushSubscriptionOptionsInit) => {
                  if (!(options.applicationServerKey instanceof Uint8Array)) throw Error("Expected decoded key bytes");
                  Reflect.set(window, "subscribedKey", Array.from(options.applicationServerKey));
                  return {
                    options,
                    toJSON: () => ({
                      endpoint: "https://web.push.apple.com/synthetic",
                      keys: { p256dh: "synthetic", auth: "synthetic" },
                    }),
                  };
                },
              },
            }),
          });
        });
        await page.route("**/push-test.html", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<div id="phonePush"></div><script type="module" src="/js/ui-phone-push.generated.js"></script>',
          }),
        );
        await page.route("**/auth/session", (route) =>
          route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }),
        );
        await page.route("**/mcp", async (route) => {
          const request = route.request();
          assert.equal(request.headers()["x-carr-csrf"], "synthetic");
          const body = request.postDataJSON();
          assert.equal(body.method, "tools/call");
          calls.push(body.params.name);
          let response: unknown;
          if (body.params.name === "read-web-push-config-v1") {
            assert.deepEqual(body.params.arguments, {});
            if (outcome === "unavailable") {
              await route.abort("failed");
              return;
            }
            if (outcome === "retired")
              await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-offline-session-revoked")));
            response = payload;
          } else if (body.params.name === "read-web-push-subscriptions-v1") {
            response = { ok: true, schema_version: "web-push-registry.v1", subscriptions: [] };
          } else {
            assert.equal(body.params.name, "register-web-push-subscription-v1");
            response = {
              ok: true,
              schema_version: "web-push-registry.v1",
              replayed: false,
              installation_id: body.params.arguments.installation_id,
              generation: 1,
              state: "active",
            };
          }
          if (body.params.name !== "read-web-push-config-v1")
            assert.equal(validateRegistry(response), true, JSON.stringify(validateRegistry.errors));
          await route.fulfill({
            json: {
              jsonrpc: "2.0",
              id: body.id,
              result: structured
                ? { structuredContent: response }
                : { isError: "error" in payload, content: [{ type: "text", text: JSON.stringify(response) }] },
            },
          });
        });
        await page.goto(`${server.origin}/push-test.html`);
        await page.getByText(expected, { exact: true }).waitFor({ timeout: 3000 });
        assert.equal(paths.includes("/public-shell/web-push-config.json"), false);
        assert.equal(calls.filter((verb) => verb === "read-web-push-config-v1").length, 1);
        if (payload === config) {
          await page.getByRole("button", { name: "Enable phone notifications" }).click();
          await page.getByRole("button", { name: "Disable phone notifications" }).waitFor();
          assert.deepEqual(
            await page.evaluate(() => Reflect.get(window, "subscribedKey")),
            Array.from(Buffer.from(config.public_key, "base64url")),
          );
        } else {
          assert.equal(await page.getByRole("button").count(), 0);
          await page.evaluate(() => {
            window.dispatchEvent(new Event("focus"));
            document.dispatchEvent(new Event("visibilitychange"));
          });
          assert.deepEqual(calls, ["read-web-push-config-v1"]);
          await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-offline-session-revoked")));
          await page.getByText("Session ended. Sign in again to manage this installation.", { exact: true }).waitFor();
        }
      } finally {
        await page.close();
      }
    });
  }
});

test("fresh Updates installation activates the root worker before enrollment", async (t) => {
  const config = JSON.parse(await readFile(new URL("./fixtures/phone-push/config.json", import.meta.url), "utf8"));
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: {
      APP_ENV: "fixture",
      CARR: {
        fetch: async (request: Request) => {
          if (new URL(request.url).pathname === "/auth/session")
            return Response.json({ actor: { slug: "joe" }, csrf_token: "synthetic" });
          const body = await request.json();
          assert.ok(["read-web-push-config-v1", "read-web-push-subscriptions-v1"].includes(body.params.name));
          const value =
            body.params.name === "read-web-push-config-v1"
              ? config
              : { ok: true, schema_version: "web-push-registry.v1", subscriptions: [] };
          return Response.json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: value } });
        },
      },
    },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const outcome of ["active", "failed", "timeout", "retired"] as const) {
    await t.test(outcome, async () => {
      const page = await browser.newPage({
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
      });
      try {
        await page.addInitScript((outcome) => {
          const original = window.matchMedia.bind(window);
          window.matchMedia = (query) => {
            const result = original(query);
            if (query === "(display-mode: standalone)") Object.defineProperty(result, "matches", { value: true });
            return result;
          };
          if (outcome === "failed")
            navigator.serviceWorker.register = async () => {
              throw Error("Installation failed");
            };
          if (outcome === "timeout" || outcome === "retired")
            navigator.serviceWorker.register = () => new Promise(() => {});
        }, outcome);
        await page.route("**/fresh-push.html", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<div id="phonePush"></div><script type="module" src="/js/ui-phone-push.generated.js"></script>',
          }),
        );
        await page.goto(`${server.origin}/fresh-push.html`);
        if (outcome === "retired") {
          await page.getByText("Preparing phone notifications…", { exact: true }).waitFor();
          await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-offline-session-revoked")));
          await page.getByText("Session ended. Sign in again to manage this installation.", { exact: true }).waitFor();
        } else if (outcome !== "active") {
          await page
            .getByText("Phone notification setup failed. Reopen Updates to try again.", { exact: true })
            .waitFor({ timeout: 15000 });
        } else {
          await page
            .getByText("Phone notifications are off on this installation.", { exact: true })
            .waitFor({ timeout: 15000 });
          assert.equal(
            await page.evaluate(async () => {
              const registration = await navigator.serviceWorker.getRegistration("/");
              return (
                registration?.active?.scriptURL === `${location.origin}/sw.js` &&
                registration.scope === `${location.origin}/`
              );
            }),
            true,
            "Updates must activate its worker without visiting Deal Room",
          );
        }
        if (outcome !== "active") assert.equal(await page.getByRole("button").count(), 0);
      } finally {
        await page.close();
      }
    });
  }
});
