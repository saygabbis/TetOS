import "dotenv/config";
const port = process.env.TETOS_PORT ?? "6453";
const authHeaders = process.env.TETOS_API_TOKEN ? { Authorization: `Bearer ${process.env.TETOS_API_TOKEN}` } : {};
const userId = process.env.TETOS_USER_ID ?? "5516988137617";
const response = await fetch(`http://localhost:${port}/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...authHeaders },
  body: JSON.stringify({ message: "Oi Teto", userId })
});

if (!response.ok) {
  const text = await response.text();
  console.error(`Error: ${response.status} ${text}`);
  process.exit(1);
}

const data = await response.json();
console.log(data);
if (Array.isArray(data.replies)) {
  console.log("Teto:", data.replies.join(" "));
}
