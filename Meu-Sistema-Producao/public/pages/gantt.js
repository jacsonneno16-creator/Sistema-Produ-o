
const machines=[
"Alfateck14","Alfateck15","Alfateck16","Alfateck17","Alfateck18",
"Alfateck19","Alfateck20","Alfateck21","Alfateck22","Alfateck23",
"Alfateck24","Alfateck25","Alfateck26","Alfateck27","Alfateck28"
]

const dias=["Seg","Ter","Qua","Qui","Sex"]

export function gantt(){

let html=`<h1>Gantt Produção</h1>
<table>
<tr><th>Máquina</th>${dias.map(d=>`<th>${d}</th>`).join("")}</tr>`

machines.forEach(m=>{
html+=`<tr class="machine"><td>${m}</td>`
dias.forEach((d,i)=>{
html+=`<td class="cell" data-machine="${m}" data-day="${i}"></td>`
})
html+="</tr>"
})

html+="</table>"

document.getElementById("content").innerHTML=html

enableDrop()
}

function enableDrop(){
document.querySelectorAll(".cell").forEach(c=>{
c.ondragover=e=>e.preventDefault()
c.ondrop=e=>{
const txt=e.dataTransfer.getData("text")
c.innerHTML=`<div class="task" draggable="true">${txt}</div>`
drag()
}
})
drag()
}

function drag(){
document.querySelectorAll(".task").forEach(t=>{
t.ondragstart=e=>{
e.dataTransfer.setData("text",t.innerText)
}
})
}
