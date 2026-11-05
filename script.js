/* SIPAT CHALLENGE
   Configure URL e chave anonima do seu projeto Supabase em CONFIG.
   Nunca coloque a service_role key neste arquivo.
*/
const CONFIG = {
  SUPABASE_URL: "https://kffdbfmawbdewnlzuqdm.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtmZmRiZm1hd2JkZXdubHp1cWRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM5MDI0ODAsImV4cCI6MjEwOTQ3ODQ4MH0.QTD_qlWUDZqrJ009HRmvscjn31t3H2Vs7_dkzRUm9NE"
};

const ready = CONFIG.SUPABASE_URL.startsWith("https://") &&
  CONFIG.SUPABASE_ANON_KEY.startsWith("ey");
const db = ready ? window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY) : null;
let participant = null;
let accessCode = "";
let activeQuestion = null;
let chosenAnswer = null;
let avatarValue = "🦊";
const $ = id => document.getElementById(id);
const avatarFaces = ["🦊","🐼","🦁","🐯","🐸","🐵","🐻","🐨","🐰","🐱","🐶","🐺","🦉","🦄","🐲","🐧","🐢","🐙","🦖","🐝","🤖","👨‍🚀","👩‍🚀","🦸","🦹","🧑‍🚒","👩‍🔧","👨‍⚕️","👩‍🔬","🧑‍🍳","🧑‍🎨","🧑‍🚀","🧙","🥷","👑","🧚","🧛","🧜","🧞","🧟","🐮","🐷","🦋","🦝","🐬","🐹","🦓","🦒","🦔","🦜","🦩","🦚","🐳","🦈","🐞","🐌","🦕","🐿️","🦥","🦦"];
const avatarColors = ["#e8f6ec","#eaf2ff","#fff3df","#f4eaff"];
const avatarCatalog = avatarColors.flatMap((color, variant) =>
  avatarFaces.map((face, index) => ({face, color, id: `${variant}-${index}`})));
function toast(message){$("toast").textContent=message;$("toast").classList.add("show");setTimeout(()=>$("toast").classList.remove("show"),2600)}
function showView(name){document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));$("view-"+name).classList.add("active");document.querySelectorAll(".nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.view===name))}
document.querySelectorAll(".nav-btn").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.view)));
function showMessage(id,msg,error=false){$(id).textContent=msg;$(id).style.color=error?"#b42318":"#168447"}
function requireConfig(){if(!db){toast("Configure a URL e a chave do Supabase no app.js.");return false}return true}
function renderAvatars(){
  const grid=$("avatar-picker");grid.innerHTML="";
  avatarCatalog.forEach(a=>{const b=document.createElement("button");b.type="button";b.className="avatar-choice"+(a.face===avatarValue?" selected":"");b.textContent=a.face;b.title="Avatar "+(Number(a.id.split("-")[0])*60+Number(a.id.split("-")[1])+1);b.style.background=a.color;b.addEventListener("click",()=>{avatarValue=a.face;renderAvatars()});grid.appendChild(b)});
}
renderAvatars();

$("login-btn").addEventListener("click",loginParticipant);
$("access-code").addEventListener("keydown",e=>{if(e.key==="Enter")loginParticipant()});
async function loginParticipant(){
  if(!requireConfig())return;
  accessCode=$("access-code").value.trim().toUpperCase();
  if(!accessCode){showMessage("login-message","Informe seu código individual.",true);return}
  const {data,error}=await db.rpc("participant_login",{p_access_code:accessCode});
  if(error||!data){showMessage("login-message",error?.message||"Código não encontrado.",true);return}
  participant=data;avatarValue=data.avatar||"🦊";
  $("login-panel").classList.add("hidden");$("participant-panel").classList.remove("hidden");
  $("my-name").textContent=data.name;$("my-sector").textContent=data.sector;$("my-avatar").textContent=avatarValue;
  renderAvatars();await refreshMyStats();showMessage("game-message","Acesso confirmado. Bom desafio!");
}
$("save-avatar").addEventListener("click",async()=>{
  if(!participant||!requireConfig())return;
  const {error}=await db.rpc("participant_set_avatar",{p_access_code:accessCode,p_avatar:avatarValue});
  if(error){showMessage("game-message",error.message,true);return}
  participant.avatar=avatarValue;$("my-avatar").textContent=avatarValue;toast("Avatar atualizado!");
});
async function refreshMyStats(){
  const {data,error}=await db.rpc("participant_my_stats",{p_access_code:accessCode});
  if(error)return;
  $("my-points").textContent=data.points??0;$("my-attempts").textContent=data.answers??0;$("my-rank").textContent=data.rank?data.rank+"º":"—";
}
$("official-btn").addEventListener("click",()=>loadQuestion("official"));
$("bonus-btn").addEventListener("click",()=>loadQuestion("bonus"));
async function loadQuestion(kind){
  if(!participant||!requireConfig())return;
  $("quiz-empty").classList.add("hidden");$("quiz-area").classList.remove("hidden");
  $("question-text").textContent="Carregando pergunta...";
  $("answer-options").innerHTML="";$("answer-feedback").textContent="";chosenAnswer=null;
  const {data,error}=await db.rpc("participant_next_question",{p_access_code:accessCode,p_kind:kind});
  if(error){$("question-text").textContent="Não foi possível carregar a pergunta.";showMessage("answer-feedback",error.message,true);return}
  if(!data||data.status==="complete"){$("question-text").textContent=kind==="official"?"Você já concluiu o desafio oficial disponível.":"Você respondeu todas as perguntas bônus disponíveis.";return}
  activeQuestion=data;$("question-kind").textContent=kind==="official"?"DESAFIO OFICIAL":"RODADA BÔNUS";$("question-points").textContent=`Vale até ${data.points} pontos`;$("question-text").textContent=data.prompt;
  data.options.forEach((option,index)=>{const b=document.createElement("button");b.className="answer-option";b.textContent=String.fromCharCode(65+index)+". "+option;b.addEventListener("click",()=>{chosenAnswer=index;document.querySelectorAll(".answer-option").forEach(x=>x.classList.remove("selected"));b.classList.add("selected")});$("answer-options").appendChild(b)});
}
$("answer-submit").addEventListener("click",submitAnswer);
async function submitAnswer(){
  if(!activeQuestion||chosenAnswer===null){showMessage("answer-feedback","Escolha uma alternativa.",true);return}
  $("answer-submit").disabled=true;
  const {data,error}=await db.rpc("participant_submit_answer",{p_access_code:accessCode,p_question_id:activeQuestion.id,p_selected_index:chosenAnswer});
  $("answer-submit").disabled=false;
  if(error){showMessage("answer-feedback",error.message,true);return}
  document.querySelectorAll(".answer-option").forEach(b=>b.disabled=true);
  showMessage("answer-feedback",data.correct?`Resposta correta! +${data.points} pontos.`:"Resposta registrada. Continue aprendendo!");
  activeQuestion=null;await refreshMyStats();await loadRanking();
}

async function loadRanking(){
  if(!requireConfig())return;
  const {data,error}=await db.rpc("public_leaderboard",{p_limit:100});
  if(error){$("ranking-body").innerHTML=`<tr><td colspan="4">Ranking indisponível.</td></tr>`;return}
  $("ranking-body").innerHTML="";
  (data||[]).forEach((p,i)=>{const tr=document.createElement("tr");tr.innerHTML=`<td>${i+1}</td><td></td><td></td><td><b>${p.points}</b></td>`;const name=document.createElement("span");name.innerHTML=`<span class="rank-avatar">${p.avatar||"🙂"}</span>`;name.append(document.createTextNode(p.name));tr.children[1].append(name);tr.children[2].textContent=p.sector;$("ranking-body").appendChild(tr)});
  if(!data?.length)$("ranking-body").innerHTML='<tr><td colspan="4">Ainda não há pontuações.</td></tr>';
}
$("refresh-ranking").addEventListener("click",loadRanking);

$("admin-login-btn").addEventListener("click",adminLogin);
async function adminLogin(){
  if(!requireConfig())return;
  const {data,error}=await db.auth.signInWithPassword({email:$("admin-email").value,password:$("admin-password").value});
  if(error){showMessage("admin-message","Não foi possível entrar. Confira suas credenciais e permissões.",true);return}
  const {data:allowed,error:roleError}=await db.from("admins").select("user_id,display_name").eq("user_id",data.user.id).maybeSingle();
  if(roleError||!allowed){await db.auth.signOut();showMessage("admin-message","Esta conta não possui permissão administrativa.",true);return}
  $("admin-login").classList.add("hidden");$("admin-panel").classList.remove("hidden");$("admin-who").textContent=allowed.display_name||data.user.email;
  await loadAdminData();
}
$("admin-logout").addEventListener("click",async()=>{await db.auth.signOut();$("admin-panel").classList.add("hidden");$("admin-login").classList.remove("hidden")});
async function loadAdminData(){
  const [p,q,a]=await Promise.all([
    db.from("participants").select("id",{count:"exact",head:true}),
    db.from("questions").select("id",{count:"exact",head:true}).eq("active",true),
    db.from("attempts").select("id",{count:"exact",head:true})
  ]);
  $("admin-participants").textContent=p.count??"—";$("admin-questions").textContent=q.count??"—";$("admin-answers").textContent=a.count??"—";
  await loadQuestionList();
  const {data}=await db.from("admin_attempts_view").select("*").order("created_at",{ascending:false}).limit(30);
  $("admin-attempts").innerHTML="";
  (data||[]).forEach(x=>{const tr=document.createElement("tr");[x.participant_name,`Dia ${x.day}`,x.kind==="official"?"Oficial":"Bônus",x.correct?"Acertou":"Errou",x.points].forEach(v=>{const td=document.createElement("td");td.textContent=v;tr.appendChild(td)});$("admin-attempts").appendChild(tr)});
}
$("add-question").addEventListener("click",async()=>{
  if(!requireConfig())return;
  const prompt=$("q-text").value.trim(),options=[0,1,2,3].map(i=>$("opt-"+i).value.trim()),points=Number($("q-points").value);
  if(!prompt||options.some(x=>!x)||!Number.isInteger(points)||points<1){showMessage("question-message","Preencha a pergunta, as quatro alternativas e os pontos.",true);return}
  const {error}=await db.from("questions").insert({day:Number($("q-day").value),kind:$("q-kind").value,points,prompt,options,correct_index:Number($("q-correct").value)});
  if(error){showMessage("question-message",error.message,true);return}
  showMessage("question-message","Pergunta cadastrada com sucesso.");$("q-text").value="";[0,1,2,3].forEach(i=>$("opt-"+i).value="");await loadAdminData();
});
$("make-qr").addEventListener("click",()=>{
  $("qr-output").innerHTML="";
  if(location.protocol==="file:"){toast("Publique o site para gerar o QR Code definitivo.");return}
  new QRCode($("qr-output"),{text:location.href.split("#")[0],width:180,height:180,colorDark:"#104d2c",colorLight:"#ffffff",correctLevel:QRCode.CorrectLevel.H});
});
$("export-ranking").addEventListener("click",async()=>{
  const {data,error}=await db.rpc("admin_export_leaderboard");
  if(error){toast("Não foi possível exportar.");return}
  const rows=[["Posição","Nome","Setor","Pontos"],...(data||[]).map((x,i)=>[i+1,x.name,x.sector,x.points])];
  const csv="\uFEFF"+rows.map(r=>r.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(";")).join("\n");
  const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));const a=document.createElement("a");a.href=url;a.download="ranking-sipat.csv";a.click();URL.revokeObjectURL(url);
});
