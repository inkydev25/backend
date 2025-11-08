// server.js
import express from 'express';
import pkg from 'pg';
import cors from 'cors';
// Importe les constantes de configuration
import { SCHEDULE_HOUR, SCHEDULE_MINUTE, SCHEDULE_DAY_OF_WEEK } from './config.js';
// Scriote du tirage
// import './draw.js';

const { Pool } = pkg;

const app = express();
const port = process.env.PORT || 3000;

// Configuration PostgreSQL pour Railway
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: true // Toujours forcer SSL en production sur Railway
});

// Utilisation de la bibliothèque 'cors' pour gérer les requêtes cross-origin
app.use(cors());

// Crée les tables si elles n'existent pas
async function initializeDatabase() {
  try {
    // Crée la table pour les gagnants AVEC colonne pdf_data
    await pool.query(`
      CREATE TABLE IF NOT EXISTS winners (
        roundId INTEGER PRIMARY KEY,
        winner TEXT NOT NULL,
        bountyTxHash TEXT,
        prizeAmount TEXT,  
        burnAmount TEXT,   
        drawDateUTC TEXT,
        totalTickets INTEGER,
        numberOfParticipants INTEGER,
        newRoundStarted INTEGER,
        newRoundTxHash TEXT,
        pdf_data BYTEA
      )
    `);

    // Crée la table pour le statut du tirage
    await pool.query(`
      CREATE TABLE IF NOT EXISTS draw_status (
        id INTEGER PRIMARY KEY, 
        status TEXT NOT NULL, 
        lastDrawDate TEXT
      )
    `);

    // Initialise le statut si la table est vide
    const result = await pool.query('SELECT COUNT(*) AS count FROM draw_status');
    if (parseInt(result.rows[0].count) === 0) {
      await pool.query('INSERT INTO draw_status (id, status, lastDrawDate) VALUES (1, $1, $2)', ['termine', new Date().toISOString()]);
    }

    console.log('✅ Connecté à la base de données PostgreSQL.');
  } catch (err) {
    console.error('Erreur lors de la connexion à la BDD', err.message);
  }
}

// Initialiser la BDD au démarrage
initializeDatabase();

// Endpoint pour récupérer tous les gagnants (triés du plus récent au plus ancien)
app.get('/winners', async (req, res) => {
  try {
    const result = await pool.query('SELECT roundId, winner, bountyTxHash, prizeAmount, burnAmount, drawDateUTC, totalTickets, numberOfParticipants, newRoundStarted, newRoundTxHash FROM winners ORDER BY roundId DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Erreur lors de la récupération des données', err.message);
    return res.status(500).json({ error: 'Error fetching winners.' });
  }
});

// Endpoint pour télécharger les PDF
app.get('/api/pdf/:roundId', async (req, res) => {
  try {
    const roundId = req.params.roundId;
    const result = await pool.query('SELECT pdf_data FROM winners WHERE roundId = $1', [roundId]);
    
    if (!result.rows.length || !result.rows[0].pdf_data) {
      return res.status(404).json({ error: 'PDF not found for this round' });
    }
    
    // Servir le PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="INKY_Tombola_report_${roundId}.pdf"`);
    res.send(result.rows[0].pdf_data);
  } catch (err) {
    console.error('Erreur récupération PDF:', err.message);
    return res.status(500).json({ error: 'Error fetching PDF' });
  }
});

// Endpoint pour obtenir l'heure du prochain tirage
app.get('/api/draw-info', (req, res) => {
  res.json({
    scheduleHour: SCHEDULE_HOUR,
    scheduleMinute: SCHEDULE_MINUTE,
    scheduleDayOfWeek: SCHEDULE_DAY_OF_WEEK
  });
});

// Endpoint pour obtenir le statut du tirage
app.get('/api/draw-status', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM draw_status WHERE id = 1');
    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.json({ status: 'termine', lastDrawDate: null });
    }
  } catch (err) {
    console.error('Erreur lors de la récupération du statut du tirage', err.message);
    return res.status(500).json({ error: 'Error fetching draw status.' });
  }
});

// Démarrer le serveur
app.listen(port, () => {
  console.log(`Serveur d'API écoutant sur http://localhost:${port}`);
});

// Gérer la fermeture de la base de données à l'arrêt du processus
process.on('SIGINT', async () => {
  await pool.end();
  console.log('Fermeture de la connexion à la base de données.');
  process.exit(0);
});

