// libpq environment keeps database credentials out of command-line arguments.
export function postgresEnvironment(connectionString) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('Use a PostgreSQL connection URL.');
  return {
    ...process.env,
    PGHOST: url.searchParams.get('host') || url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: url.searchParams.get('sslmode') || 'prefer',
    ...Object.fromEntries(
      ['sslrootcert', 'sslcert', 'sslkey']
        .filter((key) => url.searchParams.has(key))
        .map((key) => ['PG' + key.toUpperCase(), url.searchParams.get(key)]),
    ),
  };
}
