
let lista=JSON.parse(localStorage.getItem("produtos")||"[]")

export function programacao(){
document.getElementById("content").innerHTML=`
<h1>Programação</h1>
<div class="card">
Produto <input id="p">
Qtd <input id="q" type="number">
<button id="add">Adicionar</button>
</div>
<table>
<thead><tr><th>Produto</th><th>Qtd</th></tr></thead>
<tbody id="body"></tbody>
</table>
`
document.getElementById("add").onclick=()=>{
lista.push({p:document.getElementById("p").value,q:document.getElementById("q").value})
localStorage.setItem("produtos",JSON.stringify(lista))
render()
}
render()
}

function render(){
const b=document.getElementById("body")
if(!b)return
b.innerHTML=lista.map(x=>`<tr><td>${x.p}</td><td>${x.q}</td></tr>`).join("")
}
