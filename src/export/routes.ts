import { Router, Response } from 'express';
import { supabase } from '../db/client';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimit';

const router = Router();

/** Export agendamentos as CSV */
router.get('/api/export/agendamentos', requireAuth, apiLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const clinicaId = req.clinicaId;
    if (!clinicaId) { res.status(403).json({ error: 'Sem clínica' }); return; }

    const desde = (req.query.desde as string) || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const ate = (req.query.ate as string) || new Date().toISOString().split('T')[0];

    const { data } = await supabase.from('agendamentos')
      .select('*, profissionais(nome, especialidade)')
      .eq('clinica_id', clinicaId)
      .gte('data_hora', desde + 'T00:00:00')
      .lte('data_hora', ate + 'T23:59:59')
      .order('data_hora', { ascending: true });

    if (req.query.format === 'json') {
      res.json({ data: data || [], total: (data || []).length });
      return;
    }

    // CSV
    const header = 'Paciente,Telefone,Profissional,Especialidade,Data,Horario,Duracao,Status\n';
    const rows = (data || []).map(a => {
      const dt = new Date(a.data_hora);
      return [
        `"${(a.paciente_nome || '').replace(/"/g, '""')}"`,
        a.paciente_telefone || '',
        `"${((a.profissionais as any)?.nome || '').replace(/"/g, '""')}"`,
        `"${((a.profissionais as any)?.especialidade || '').replace(/"/g, '""')}"`,
        dt.toLocaleDateString('pt-BR'),
        dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        (a.duracao_minutos || 30) + 'min',
        a.status,
      ].join(',');
    }).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=agendamentos-${desde}-${ate}.csv`);
    res.send('\uFEFF' + header + rows); // BOM for Excel UTF-8
  } catch (e) {
    res.status(500).json({ error: 'Erro ao exportar' });
  }
});

/** Export financial report as CSV */
router.get('/api/export/financeiro', requireAuth, apiLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const clinicaId = req.clinicaId;
    if (!clinicaId) { res.status(403).json({ error: 'Sem clínica' }); return; }

    const desde = (req.query.desde as string) || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const ate = (req.query.ate as string) || new Date().toISOString().split('T')[0];

    const { data: ags } = await supabase.from('agendamentos')
      .select('*, profissionais(nome)').eq('clinica_id', clinicaId)
      .eq('status', 'confirmado').gte('data_hora', desde + 'T00:00:00').lte('data_hora', ate + 'T23:59:59');

    const { data: servicos } = await supabase.from('servicos').select('*').eq('clinica_id', clinicaId).eq('ativo', true);

    const header = 'Data,Paciente,Profissional,Servico,Valor\n';
    const rows = (ags || []).map(a => {
      const serv = (servicos || []).find(s => s.duracao_minutos === a.duracao_minutos);
      const valor = serv?.preco || 0;
      return [
        new Date(a.data_hora).toLocaleDateString('pt-BR'),
        `"${(a.paciente_nome || '').replace(/"/g, '""')}"`,
        `"${((a.profissionais as any)?.nome || '').replace(/"/g, '""')}"`,
        `"${(serv?.nome || 'Consulta').replace(/"/g, '""')}"`,
        valor.toFixed(2),
      ].join(',');
    }).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=financeiro-${desde}-${ate}.csv`);
    res.send('\uFEFF' + header + rows);
  } catch (e) {
    res.status(500).json({ error: 'Erro ao exportar' });
  }
});

export default router;
