import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { Pool } from 'pg';
import { 
  isDateString, 
  isNumericString, 
  parseDate, 
  parseValuation
} from '../lib/helpers'
import "dotenv/config";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seed(csvFile: string) {
  const table = path.basename(csvFile, '.csv');
  const content = fs.readFileSync(csvFile, 'utf8');
  const lines = content.split(/\r?\n/);
  if (!lines.length) {
    console.error('CSV file is empty');
    return;
  }

  // picks the first 10 lines if it exists to guess the delimiter
  const sample = lines.slice(0, Math.min(lines.length, 10));
  const avgComma = sample.reduce((sum, l) => sum + (l.split(',').length - 1), 0) / sample.length;
  const avgSemi  = sample.reduce((sum, l) => sum + (l.split(';').length - 1), 0) / sample.length;
  const delimiter = avgSemi > avgComma ? ';' : ',';
  console.log(`Detected delimiter '${delimiter}' (commas=${avgComma}, semicolons=${avgSemi})`);

  const counts = lines.map(l => l.split(delimiter).length);
  let headerIndex = counts.findIndex((c, i) => i < counts.length - 1 && c > 1 && c === counts[i+1]);
  if (headerIndex === -1) headerIndex = 0;
  console.log(`Using line ${headerIndex + 1} as header row`);

  const rows: Record<string,string>[] = [];
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(csvFile)
      .pipe(csv({ separator: delimiter, skipLines: headerIndex }))
      .on('data', row => rows.push(row))
      .on('end', resolve)
      .on('error', reject);
  });

  if (!rows.length) {
    console.warn('No data rows found after header');
    return;
  }

  const rawCols = Object.keys(rows[0]).filter(orig => orig && orig.trim().length > 0);
  const headerSlugs = rawCols.map(orig => ({
    orig,
    slug: orig.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''),
  }));
  const cols = Array.from(new Set(headerSlugs.map(h => h.slug)));

  console.log(`Columns mapped: ${cols.join(', ')}`);

  type ColType = 'date' | 'numeric' | 'text';
  const columnTypes: Record<string, ColType> = {};
  for (const { orig, slug } of headerSlugs) {
    const samples = rows
      .map(r => (r[orig]||'').trim())
      .filter(v => v !== '')
      .slice(0, 30);
    const dateCount = samples.filter(isDateString).length;
    const numCount  = samples.filter(isNumericString).length;
    if (samples.length > 0 && dateCount / samples.length > 0.8) {
      columnTypes[slug] = 'date';
    } else if (samples.length > 0 && numCount / samples.length > 0.8) {
      columnTypes[slug] = 'numeric';
    } else {
      columnTypes[slug] = 'text';
    }
  }
  console.log('Inferred column types:', columnTypes);

  // build DDL from inferred types
  const colDefs = cols.map(c => {
    switch (columnTypes[c]) {
      case 'date':    return `"${c}" DATE`;
      case 'numeric': return `"${c}" NUMERIC`;
      default:        return `"${c}" TEXT`;
    }
  }).join(', ');

  await pool.query(`DROP TABLE IF EXISTS "${table}";`);
  await pool.query(`CREATE TABLE "${table}" (${colDefs});`);
  console.log(`✅ Created table "${table}" with columns: ${cols.join(', ')}`);

  for (const row of rows) {
    const values = cols.map(c => {
      const { orig } = headerSlugs.find(h => h.slug === c)!;
      const raw = row[orig];
      if (!raw?.trim()) return null;

      switch (columnTypes[c]) {
        case 'date':
          return parseDate(raw.trim());
        case 'numeric':
          // this case handles a specific column of unicorns csv file
          if (c.includes('valuation')) {
            return parseValuation(raw);
          }
          // generic numeric parse:
          const cleaned = raw
            .replace(/\u00A0/g,' ')
            .replace(/[^\d.,\-]/g,'')
            .replace(/\.(?=\d{3,}\b)/g,'')
            .replace(/,/g,'.');
          return parseFloat(cleaned);
        default:  // text
          return raw.trim();
      }
    });

    if (values.some(v => v === null)) {
     continue;
   }

    const placeholders = values.map((_, i) => `$${i+1}`).join(', ');
    await pool.query(
      `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${placeholders});`,
      values
    );
  }

  console.log(`✅ Seeded ${rows.length} rows into "${table}"`);
  await pool.end();
}

const [csvFile] = process.argv.slice(2);
if (!csvFile) {
  console.error('Usage: DATABASE_URL=… tsx seed.ts <csv-file>');
  process.exit(1);
}

seed(csvFile).catch(err => { console.error(err); process.exit(1); });
