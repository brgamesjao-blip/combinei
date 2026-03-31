import { Router } from 'express';
import { gerarURLAutorizacao, trocarCodigoPorTokens } from './client';
import { salvarTokensGoogle } from '../db/client';

const router = Router();

router.get('/auth/google', (req, res) => {
  const id = (req.query.clinica_id as string) || 'default';
  res.redirect(gerarURLAutorizacao() + `&state=${id}`);
});

router.get('/auth/google/callback', async (req, res) => {
  const code = req.query.code as string;
  const id = (req.query.state as string) || 'default';
  if (!code) { res.status(400).send('Sem código'); return; }
  try {
    const tokens = await trocarCodigoPorTokens(code);
    if (id !== 'default') await salvarTokensGoogle(id, tokens);
    res.send('<h1>✅ Google Calendar conectado!</h1><p>Pode fechar esta janela.</p>');
  } catch (e) { res.status(500).send('Erro ao conectar'); }
});

export default router;
