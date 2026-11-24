process.env.STORE_BACKEND = "memory";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const store = require("../src/store");
const { app } = require("../src/server");

test("HTTP: health, sign-in, admin protection and the removed interview routes", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, method = "GET", body, token) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: response.status === 204 ? null : await response.json() };
  };

  assert.equal((await request("/health")).data.status, "ok");
  assert.equal((await request("/health/ai")).status, 200);
  assert.equal((await request("/tutor/topics")).status, 401, "tutor routes need a signed-in user");

  const registered = await request("/auth/register", "POST", { name: "HTTP", email: "platform@test.dev", password: "secret1" });
  assert.equal(registered.status, 201);
  const { token, user } = registered.data;
  assert.equal((await request("/auth/me", "GET", undefined, token)).status, 200);
  assert.equal((await request("/tutor/topics", "GET", undefined, token)).status, 200);

  // admin routes need the admin role
  assert.equal((await request("/admin/usage", "GET", undefined, token)).status, 403);
  await store.users.set(user.id, { ...(await store.users.get(user.id)), role: "teacher" });
  assert.equal((await request("/admin/usage", "GET", undefined, token)).status, 403, "a teacher is not an admin");

  // the InterviewAI features are gone
  for (const path of ["/scenarios", "/sessions", "/documents", "/coach/chat", "/plans", "/progress", "/speech/status"]) {
    assert.equal((await request(path, "GET", undefined, token)).status, 404, path);
  }

  await request("/auth/logout", "POST", {}, token);
  assert.equal((await request("/tutor/topics", "GET", undefined, token)).status, 401);
});
