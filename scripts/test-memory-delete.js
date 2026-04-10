const id = process.argv[2];

if (!id) {
  console.error("Usage: node scripts/test-memory-delete.js <id>");
  process.exit(1);
}

const port = process.env.TETOS_PORT ?? "6453";
const response = await fetch(`http://localhost:${port}/memory/delete`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ id })
});

if (!response.ok) {
  const text = await response.text();
  console.error(`Error: ${response.status} ${text}`);
  process.exit(1);
}

const data = await response.json();
console.log(data);
