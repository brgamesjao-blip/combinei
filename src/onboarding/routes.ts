import { Router } from 'express';
import { supabase } from '../db/client';

const router = Router();

router.post('/api/onboarding/clinica', async (req, res) => {
  try {
    const { nome, telefone, horario_abertura, horario_fechamento } = req.body;
    const { data, error } = await supabase.from('clinicas').insert({
      nome, telefone, horario_abertura: horario_abertura || '08:00',
      horario_fechamento: horario_fechamento || '18:00', ativa: true,
    }).select().single();
    if (error) throw error;
    res.json({ ok: true, clinica: data });
  } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/api/onboarding/profissional', async (req, res) => {
  try {
    const { clinica_id, nome, especialidade } = req.body;
    const { data, error } = await supabase.from('profissionais').insert({
      clinica_id, nome, especialidade, ativo: true,
    }).select().single();
    if (error) throw error;
    res.json({ ok: true, profissional: data });
  } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/api/onboarding/servico', async (req, res) => {
  try {
    const { clinica_id, nome, duracao_minutos, preco } = req.body;
    const { data, error } = await supabase.from('servicos').insert({
      clinica_id, nome, duracao_minutos: duracao_minutos || 30, preco, ativo: true,
    }).select().single();
    if (error) throw error;
    res.json({ ok: true, servico: data });
  } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/api/onboarding/zapi', async (req, res) => {
  try {
    const { clinica_id, instance_id } = req.body;
    const { error } = await supabase.from('clinicas').update({ phone_number_id: instance_id }).eq('id', clinica_id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/onboarding', (_, res) => { res.send(PAGE); });

const PAGE = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Combinei — Setup da Clínica</title>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@400;600;700&family=Plus+Jakarta+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Plus Jakarta Sans',sans-serif;background:#FAFAF7;color:#1B1B18;min-height:100vh}
.container{max-width:560px;margin:0 auto;padding:40px 24px}
.logo{font-family:'Bricolage Grotesque',sans-serif;font-size:1.5rem;font-weight:700;color:#0A6847;margin-bottom:8px}
.subtitle{color:#8A8A82;font-size:0.9rem;margin-bottom:40px}
.steps{display:flex;gap:8px;margin-bottom:40px}
.step-dot{width:100%;height:4px;border-radius:2px;background:#E8E6E1;transition:background 0.3s}
.step-dot.active{background:#0A6847}
.step-dot.done{background:#B4D6C5}
.card{background:#fff;border:1px solid #E8E6E1;border-radius:16px;padding:32px;margin-bottom:24px}
.card h2{font-family:'Bricolage Grotesque',sans-serif;font-size:1.3rem;font-weight:700;margin-bottom:4px}
.card p{color:#8A8A82;font-size:0.85rem;margin-bottom:24px}
label{display:block;font-size:0.82rem;font-weight:600;color:#4A4A45;margin-bottom:6px;margin-top:16px}
input,select{width:100%;padding:12px 14px;border:1.5px solid #E8E6E1;border-radius:10px;font-size:0.9rem;font-family:inherit;background:#FAFAF7;transition:border 0.2s}
input:focus,select:focus{outline:none;border-color:#0A6847}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:14px;border-radius:10px;font-size:0.95rem;font-weight:600;font-family:inherit;cursor:pointer;border:none;transition:all 0.2s;text-decoration:none}
.btn-primary{background:#0A6847;color:#fff}
.btn-primary:hover{background:#074D35}
.btn-secondary{background:#fff;color:#1B1B18;border:1.5px solid #E8E6E1}
.btn-secondary:hover{border-color:#1B1B18}
.btn-small{padding:10px 16px;font-size:0.82rem;width:auto}
.prof-list,.serv-list{margin:16px 0}
.prof-item,.serv-item{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#FAFAF7;border-radius:8px;margin-bottom:8px;font-size:0.88rem}
.prof-item span,.serv-item span{color:#8A8A82;font-size:0.8rem}
.success{text-align:center;padding:48px 32px}
.success h2{color:#0A6847;font-size:1.5rem;margin-bottom:12px}
.hidden{display:none}
.mt{margin-top:16px}
.info-box{background:#E6F2EC;border-radius:10px;padding:16px;font-size:0.85rem;color:#074D35;margin:16px 0;line-height:1.6}
</style>
</head>
<body>
<div class="container">
<div class="logo">Combinei</div>
<div class="subtitle">Setup da clinica — leva menos de 5 minutos</div>
<div class="steps">
<div class="step-dot active" id="dot1"></div>
<div class="step-dot" id="dot2"></div>
<div class="step-dot" id="dot3"></div>
<div class="step-dot" id="dot4"></div>
</div>
<div id="step1">
<div class="card">
<h2>Dados da clinica</h2>
<p>Informacoes basicas do seu estabelecimento</p>
<label>Nome da clinica *</label>
<input id="clinica_nome" placeholder="Ex: Clinica Saude Viva">
<label>Telefone (WhatsApp)</label>
<input id="clinica_telefone" placeholder="Ex: 11999999999">
<div class="row">
<div><label>Abertura</label><input id="clinica_abertura" value="08:00" type="time"></div>
<div><label>Fechamento</label><input id="clinica_fechamento" value="18:00" type="time"></div>
</div>
</div>
<button class="btn btn-primary" onclick="salvarClinica()">Continuar</button>
</div>
<div id="step2" class="hidden">
<div class="card">
<h2>Profissionais</h2>
<p>Adicione os profissionais que atendem na clinica</p>
<div class="prof-list" id="profList"></div>
<div class="row">
<div><label>Nome</label><input id="prof_nome" placeholder="Ex: Dra. Ana Silva"></div>
<div><label>Especialidade</label><input id="prof_esp" placeholder="Ex: Clinico Geral"></div>
</div>
<button class="btn btn-secondary btn-small mt" onclick="addProf()">+ Adicionar profissional</button>
</div>
<div class="card">
<h2>Servicos</h2>
<p>Adicione os servicos oferecidos</p>
<div class="serv-list" id="servList"></div>
<div class="row">
<div><label>Servico</label><input id="serv_nome" placeholder="Ex: Consulta"></div>
<div><div class="row">
<div><label>Duracao (min)</label><input id="serv_duracao" value="30" type="number"></div>
<div><label>Preco (R$)</label><input id="serv_preco" placeholder="250" type="number"></div>
</div></div>
</div>
<button class="btn btn-secondary btn-small mt" onclick="addServ()">+ Adicionar servico</button>
</div>
<button class="btn btn-primary" onclick="irStep3()">Continuar</button>
</div>
<div id="step3" class="hidden">
<div class="card">
<h2>Conectar WhatsApp</h2>
<p>Vincule o numero da clinica ao sistema</p>
<div class="info-box">Para conectar o WhatsApp, nossa equipe vai te enviar um QR Code. Basta escanear com o celular da clinica em <b>Configuracoes - Aparelhos conectados - Conectar aparelho</b>.</div>
<label>ID da instancia Z-API (preenchido pela equipe)</label>
<input id="zapi_id" placeholder="Sera preenchido pela equipe Combinei">
</div>
<button class="btn btn-primary" onclick="salvarZapi()">Continuar</button>
<button class="btn btn-secondary mt" onclick="irStep4()">Pular por enquanto</button>
</div>
<div id="step4" class="hidden">
<div class="card">
<h2>Conectar Google Calendar</h2>
<p>Vincule a agenda do Google da clinica</p>
<div class="info-box">Clique no botao abaixo pra autorizar o acesso ao Google Calendar. Voce vai logar na conta Google da clinica e permitir que a Combinei crie e consulte eventos na agenda.<br><br>Isso e feito <b>uma unica vez</b>.</div>
<a id="calendarBtn" class="btn btn-primary mt" href="#" target="_blank">Conectar Google Calendar</a>
</div>
<button class="btn btn-primary mt" onclick="finalizar()">Finalizar setup</button>
</div>
<div id="stepDone" class="hidden">
<div class="card success">
<h2>Tudo pronto!</h2>
<p style="color:#4A4A45;font-size:1rem;margin-bottom:24px">A clinica <b id="nomeClinicaFinal"></b> esta configurada e pronta pra receber agendamentos pelo WhatsApp.</p>
<div class="info-box" style="text-align:left"><b>Resumo:</b><br><span id="qtdProfs">0</span> profissionais cadastrados<br><span id="qtdServs">0</span> servicos configurados<br>WhatsApp: <span id="statusZap">pendente</span><br>Google Calendar: <span id="statusCal">verificar</span></div>
</div>
</div>
</div>
<script>
let clinicaId=null;let profs=[];let servs=[];
function updateDots(s){for(let i=1;i<=4;i++){const d=document.getElementById('dot'+i);d.className='step-dot';if(i<s)d.className='step-dot done';if(i===s)d.className='step-dot active'}}
function show(id){['step1','step2','step3','step4','stepDone'].forEach(s=>document.getElementById(s).classList.add('hidden'));document.getElementById(id).classList.remove('hidden')}
async function salvarClinica(){const n=document.getElementById('clinica_nome').value.trim();if(!n){alert('Preencha o nome');return}const r=await fetch('/api/onboarding/clinica',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:n,telefone:document.getElementById('clinica_telefone').value.trim(),horario_abertura:document.getElementById('clinica_abertura').value,horario_fechamento:document.getElementById('clinica_fechamento').value})});const d=await r.json();if(d.ok){clinicaId=d.clinica.id;show('step2');updateDots(2)}else{alert('Erro: '+d.error)}}
async function addProf(){const n=document.getElementById('prof_nome').value.trim();const e=document.getElementById('prof_esp').value.trim();if(!n||!e){alert('Preencha nome e especialidade');return}const r=await fetch('/api/onboarding/profissional',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clinica_id:clinicaId,nome:n,especialidade:e})});const d=await r.json();if(d.ok){profs.push({nome:n,especialidade:e});document.getElementById('prof_nome').value='';document.getElementById('prof_esp').value='';renderProfs()}}
function renderProfs(){document.getElementById('profList').innerHTML=profs.map(p=>'<div class="prof-item"><div><b>'+p.nome+'</b> <span>'+p.especialidade+'</span></div></div>').join('')}
async function addServ(){const n=document.getElementById('serv_nome').value.trim();const du=document.getElementById('serv_duracao').value;const pr=document.getElementById('serv_preco').value;if(!n){alert('Preencha o nome do servico');return}const r=await fetch('/api/onboarding/servico',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clinica_id:clinicaId,nome:n,duracao_minutos:+du,preco:pr?+pr:null})});const d=await r.json();if(d.ok){servs.push({nome:n,duracao:du,preco:pr});document.getElementById('serv_nome').value='';document.getElementById('serv_preco').value='';renderServs()}}
function renderServs(){document.getElementById('servList').innerHTML=servs.map(s=>'<div class="serv-item"><div><b>'+s.nome+'</b> <span>'+s.duracao+'min'+(s.preco?' R$'+s.preco:'')+'</span></div></div>').join('')}
function irStep3(){if(profs.length===0){alert('Adicione pelo menos 1 profissional');return}if(servs.length===0){alert('Adicione pelo menos 1 servico');return}show('step3');updateDots(3)}
async function salvarZapi(){const id=document.getElementById('zapi_id').value.trim();if(id){await fetch('/api/onboarding/zapi',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clinica_id:clinicaId,instance_id:id})})}irStep4()}
function irStep4(){show('step4');updateDots(4);document.getElementById('calendarBtn').href='/auth/google?clinica_id='+clinicaId}
function finalizar(){show('stepDone');document.getElementById('nomeClinicaFinal').textContent=document.getElementById('clinica_nome').value;document.getElementById('qtdProfs').textContent=profs.length;document.getElementById('qtdServs').textContent=servs.length;document.getElementById('statusZap').textContent=document.getElementById('zapi_id').value?'conectado':'pendente';document.getElementById('statusCal').textContent='verificar'}
</script>
</body>
</html>`;

export default router;
