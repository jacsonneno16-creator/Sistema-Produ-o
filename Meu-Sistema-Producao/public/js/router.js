
import { dashboard } from "../pages/dashboard.js"
import { programacao } from "../pages/programacao.js"
import { maquinas } from "../pages/maquinas.js"
import { gantt } from "../pages/gantt.js"
import { realizado } from "../pages/realizado.js"
import { ficha } from "../pages/ficha.js"
import { importar } from "../pages/importar.js"

export function router(){
const p=location.hash.replace("#","")
switch(p){
case "dashboard": dashboard();break
case "programacao": programacao();break
case "maquinas": maquinas();break
case "gantt": gantt();break
case "realizado": realizado();break
case "ficha": ficha();break
case "importar": importar();break
}
}
