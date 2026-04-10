const port = process.env.TETOS_PORT ?? "6453";
const response = await fetch(`http://localhost:${port}/memory/save`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    content: "Gosta de baguete e pão.",
    tags: ["bread", "teto", "favorite"]
  })
});

if (!response.ok) {
  const text = await response.text();
  console.error(`Error: ${response.status} ${text}`);
  process.exit(1);
}

const data = await response.json();
console.log(data);
