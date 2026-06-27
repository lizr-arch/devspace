const baseUrl = process.env.OPENAI_BASE_URL || "http://127.0.0.1:11435/v1";
const url = baseUrl + "/chat/completions";

console.log("Probing:", url);

try {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer fake-key"
    },
    body: JSON.stringify({
      model: "mock-model",
      messages: [{ role: "user", content: "test" }]
    }),
    signal: controller.signal
  });

  clearTimeout(timeoutId);

  console.log("status", res.status);
  const text = await res.text();
  console.log("response:", text);

  const data = JSON.parse(text);
  console.log("parsed OK:", !!data.choices);
} catch (err) {
  console.error("ERROR:", err.message);
  process.exit(1);
}
