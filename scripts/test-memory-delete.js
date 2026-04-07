const id = process.argv[2];

if (!id) {
  console.error("Usage: node scripts/test-memory-delete.js <id>");
  process.exit(1);
}

const response = await fetch("http://localhost:3000/memory/delete", {
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
