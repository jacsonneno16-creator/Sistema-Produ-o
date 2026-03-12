
export function importar(){
document.getElementById("content").innerHTML=`
<h1>Importar Excel</h1>
<input type="file" id="file">
<pre id="out"></pre>
`
document.getElementById("file").onchange=e=>{
const reader=new FileReader()
reader.onload=evt=>{
const data=new Uint8Array(evt.target.result)
const wb=XLSX.read(data,{type:"array"})
const sheet=wb.Sheets[wb.SheetNames[0]]
const json=XLSX.utils.sheet_to_json(sheet)
document.getElementById("out").textContent=JSON.stringify(json,null,2)
}
reader.readAsArrayBuffer(e.target.files[0])
}
}
