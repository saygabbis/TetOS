const response = await fetch(
  "http://localhost:3000/memory/search?tag=bread,teto"
);

if (!response.ok) {
  const text = await response.text();
  console.error(`Error: ${response.status} ${text}`);
  process.exit(1);
}

const data = await response.json();
console.log(data);
