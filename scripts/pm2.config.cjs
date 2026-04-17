module.exports = {
  apps: [
    {
      name: 'tetos-api',
      script: 'src/infra/api/server.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'tetos-wa',
      script: 'src/integrations/whatsapp/runner.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
