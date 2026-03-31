import { Router, Request, Response } from 'express';
import { gerarURLAutorizacao, trocarCodigoPorTokens } from './client';
import { salvarTokensGoogle } from '../db/client';

// ═══════════════════════════════════════
// Rotas de autenticação Google Calendar
// Salva tokens no Supabase por clínica
// ═══════════════════════════════════════

const router = Router();

/**
 * GET /auth/google?clinica_id=xxx
 * Redireciona a clínica pro Google pra autorizar.
 * Passa clinica_id como state pra saber qual clínica autorizou.
 */
router.get('/auth/google', (req: Request, res: Response) => {
  const clinicaId = req.query.clinica_id as string || 'default';
  const url = gerarURLAutorizacao() + `&state=${clinicaId}`;
  console.log(`🔗 Autorizando Calendar pra clínica: ${clinicaId}`);
  res.redirect(url);
});

/**
 * GET /auth/google/callback
 * Google redireciona de volta com código + state (clinica_id).
 */
router.get('/auth/google/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const clinicaId = req.query.state as string || 'default';

  if (!code) {
    res.status(400).send('Código de autorização não encontrado.');
    return;
  }

  try {
    const tokens = await trocarCodigoPorTokens(code);

    // Salvar tokens no Supabase vinculado à clínica
    if (clinicaId !== 'default') {
      await salvarTokensGoogle(clinicaId, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
      });
      console.log(`✅ Tokens salvos no banco pra clínica ${clinicaId}`);
    }

    res.send(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding:60px;">
          <h1 style="color:#0A6847;">✅ Google Calendar conectado!</h1>
          <p>A Combinei agora pode acessar a agenda da sua clínica.</p>
          <p style="color:#888;">Pode fechar esta janela.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Erro na autenticação:', error);
    res.status(500).send('Erro ao conectar com o Google Calendar.');
  }
});

export default router;
