

import api, { route } from "@forge/api";
import { kvs, WhereConditions } from '@forge/kvs';
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Función auxiliar para mover un ticket a la aprobación manual si la automatización falla.
 * @param {string} issueId - El ID del ticket a mover.
 * @param {string} reason - El motivo por el cual falló la automatización.
 */
async function moveToManualApproval(issueId, reason) {
  console.log(`Moviendo ticket ${issueId} a aprobación manual. Razón: ${reason}`);
  try {
    const transitionsResponse = await api.asApp().requestJira(route`/rest/api/3/issue/${issueId}/transitions`);
    const transitionsData = await transitionsResponse.json();
    const manualTransition = transitionsData.transitions.find(t => t.name.toUpperCase() === 'APROBACIÓN MANUAL');

    if (manualTransition) {
      await api.asApp().requestJira(route`/rest/api/3/issue/${issueId}/transitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transition: { id: manualTransition.id }}),
        });
    } else {
      console.error(`No se encontró la transición "Aprobación manual" para el ticket ${issueId}.`);
    }
  } catch (e) {
    console.error(`Error crítico al intentar mover el ticket ${issueId} a manual:`, e);
  }
}


async function getPrioritizedInitialCost(issue) {
  const assetField = issue.fields[process.env.ASSET_FIELD_ID]; 

  const initialCost = parseFloat(issue.fields[process.env.COSTOE_FIELD_ID]); 
  if (initialCost) {
    return { cost: initialCost, source: 'initial' };
  }
  
  return null;
}

/**
 * Handler principal que se activa cuando un ticket está en el estado "EN AUTOMATIZACIÓN".
 */
export const automationHandler = async (event, context) => {
  const issueId = event.issue.id;
  const statusName = event.issue.fields.status.name.toUpperCase();

  if (statusName !== 'EN REVISIÓN') {
    return;
  }

  console.log(`Ticket ${issueId} detectado en 'EN AUTOMATIZACIÓN'. Iniciando proceso...`);
  await delay(5000);
  try {
    
    const issueDetailsResponse = await api.asApp().requestJira(route`/rest/api/3/issue/${issueId}?expand=renderedFields`);
    const issue = await issueDetailsResponse.json();

    // 1. Validar que tenemos los datos necesarios (costo y organización)
    const costResult = await getPrioritizedInitialCost(issue);

    if (costResult === null) {
      await moveToManualApproval(issueId, "No se pudo determinar un costo inicial (ni de activo ni manual).");
      return;
    }

    const costoEstimado = costResult.cost;
    const costoSource = costResult.source;

    const fieldIdForInitialCost = process.env.COSTOE_FIELD_ID;
    if (costoSource === 'asset' && parseFloat(issue.fields[fieldIdForInitialCost]) !== costoEstimado) {
      console.log(`Actualizando "Costo inicial" del ticket con el precio del activo: ${costoEstimado}`);
      await api.asApp().requestJira(route`/rest/api/3/issue/${issueId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { [fieldIdForInitialCost]: costoEstimado } })
      });
    }

    const organizationsField = issue.fields['customfield_10002']; 

    if (!organizationsField || organizationsField.length === 0) {
      await moveToManualApproval(issueId, "Falta la organización en el ticket.");
      return;
    }
    const organization = organizationsField[0];

    // 2. Buscar el presupuesto del cliente en la base de datos de Forge
    const allCustomersQuery = await kvs.query().where('key', WhereConditions.beginsWith('cliente-')).limit(100).getMany();
    const clienteEncontrado = allCustomersQuery.results.find(item => item.value.organizationId === organization.id);

    if (!clienteEncontrado || clienteEncontrado.value.presupuesto === null || clienteEncontrado.value.presupuesto === undefined) {
      await moveToManualApproval(issueId, `No se encontró un presupuesto registrado para la organización "${organization.name}".`);
      return;
    }
    const { vigenciaInicio, vigenciaFin, presupuesto } = clienteEncontrado.value; 
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0); 
    const fechaInicio = new Date(vigenciaInicio);
    const fechaFin = new Date(vigenciaFin);
    console.log(`Comparando Costo (${costoEstimado}) vs Presupuesto (${presupuesto}) para "${organization.name}".`);

    // 3. Decidir el camino: Auto-Aprobación o Auto-Rechazo
    let decision = '';
    if (hoy < fechaInicio || hoy > fechaFin) {
      decision = 'Auto Rechazo';
      console.log(`Decisión: Rechazado. El contrato no está vigente. Rango: ${vigenciaInicio} a ${vigenciaFin}.`);
    } 
    // 2. SEGUNDA VERIFICACIÓN: Si está vigente, ¿el costo está dentro del presupuesto?
    else if (parseFloat(costoEstimado) <= parseFloat(presupuesto)) {
      decision = 'Auto Aprobación';
      console.log(`Decisión: Aprobado. El costo (${costoEstimado}) está dentro del presupuesto (${presupuesto}).`);
    } 
    // 3. Si no se cumplen las condiciones anteriores, se rechaza.
    else {
      decision = 'Auto Rechazo';
      console.log(`Decisión: Rechazado. El costo (${costoEstimado}) excede el presupuesto (${presupuesto}).`);
    }
    
    // 4. Ejecutar la transición final
    const transitionsResponse = await api.asApp().requestJira(route`/rest/api/3/issue/${issueId}/transitions`);
    const transitionsData = await transitionsResponse.json();
    const targetTransition = transitionsData.transitions.find(t => t.name.toUpperCase() === decision.toUpperCase());

    if (targetTransition) {
      await api.asApp().requestJira(route`/rest/api/3/issue/${issueId}/transitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transition: { id: targetTransition.id } }),
      });
      console.log(`Ticket ${issueId} procesado exitosamente, movido vía "${decision}".`);
    } else {
      await moveToManualApproval(issueId, `No se encontró la transición final "${decision}".`);
    }

  } catch (error) {
    console.error(`Error inesperado procesando el ticket ${issueId}:`, error);
    await moveToManualApproval(issueId, `Ocurrió un error inesperado durante la automatización.`);
  }
};


export const resolutionHandler = async (event, context) => {
  const issueId = event.issue.id;
  const newStatus = event.issue.fields.status.name.toUpperCase();
  const costoFinalADescontar = await calculateAndUpdateCosts(issueId);

  // 1. FILTRO POR ESTADO
  // Actuar si el estado es RESUELTO o COMPLETADO
  if (newStatus !== 'RESUELTO' && newStatus !== 'COMPLETADO') {
    return;
  }

  console.log(`Ticket ${issueId} detectado como resuelto/completado. Obteniendo detalles...`);

  try {
    // 2. OBTENER DATOS FRESCOS DEL TICKET
    const issueDetailsResponse = await api.asApp().requestJira(route`/rest/api/3/issue/${issueId}`);
    const issue = await issueDetailsResponse.json();

    // 3. VERIFICAR LA RESOLUCIÓN
    const resolution = issue.fields.resolution?.name.toUpperCase();
    if (resolution !== 'DONE') {
      console.log(`El ticket ${issueId} se resolvió, pero la resolución no es "DONE". No se resta presupuesto.`);
      return;
    }

    
    // 4. OBTENER AMBOS CAMPOS DE COSTO
    const costoEstimado = parseFloat(issue.fields[process.env.COSTOE_FIELD_ID]);
    const costoTotal = parseFloat(issue.fields[process.env.COSTOT_FIELD_ID]); 

    let costoFinalADescontar = 0;

    // 5. DECIDIR QUÉ COSTO USAR
    if (costoTotal && costoTotal > 0) {
      costoFinalADescontar = costoTotal;
      console.log(`Se usará el "Costo total" para el descuento: ${costoTotal}.`);
    } 
    else if (costoEstimado) {
      costoFinalADescontar = costoEstimado;
      console.log(`No se encontró "Costo total" válido. Se usará el "Costo estimado" para el descuento: ${costoEstimado}.`);
    } 
    else {
      console.log(`El ticket ${issueId} no tiene "Costo total" ni "Costo estimado". No se resta presupuesto.`);
      return;
    }


    // 6. BUSCAR DATOS DEL CLIENTE Y ACTUALIZAR PRESUPUESTO
    const organizationsField = issue.fields['customfield_10002']; 
    if (!organizationsField || organizationsField.length === 0) {
      console.log(`El ticket ${issueId} no tiene organización. No se resta presupuesto.`);
      return;
    }
    const organization = organizationsField[0];

    const allCustomersQuery = await kvs.query().where('key', WhereConditions.beginsWith('cliente-')).getMany();
    const clienteEncontrado = allCustomersQuery.results.find(item => item.value.organizationId === organization.id);
    
    if (!clienteEncontrado || clienteEncontrado.value.presupuesto === null || clienteEncontrado.value.presupuesto === undefined) {
      console.log(`No se encontró un presupuesto para la organización "${organization.name}".`);
      return;
    }

    const clienteKey = clienteEncontrado.key;
    const clienteData = clienteEncontrado.value;
    const presupuestoActual = parseFloat(clienteData.presupuesto);

    // 7. CALCULAR Y GUARDAR EL NUEVO PRESUPUESTO
    const nuevoPresupuesto = presupuestoActual - costoFinalADescontar;
    console.log(`Presupuesto anterior para "${clienteData.name}": ${presupuestoActual}. Monto a descontar: ${costoFinalADescontar}. Nuevo presupuesto: ${nuevoPresupuesto}.`);
    
    const clienteActualizado = {
      ...clienteData,
      presupuesto: nuevoPresupuesto
    };
    
    await kvs.set(clienteKey, clienteActualizado);
    console.log(`Presupuesto para la organización "${clienteData.name}" actualizado.`);

  } catch (error) {
    console.error(`Error al actualizar el presupuesto para el ticket ${issueId}:`, error);
  }
};


async function calculateAndUpdateCosts(issueId) {
  try {
    console.log(`[CÁLCULO] Iniciando para el ticket ${issueId}`);
    const issue = await api.asApp().requestJira(route`/rest/api/3/issue/${issueId}`).then(res => res.json());

    // 1. OBTENER TODOS LOS COSTOS
    const costoInicial = parseFloat(issue.fields[process.env.COSTOE_FIELD_ID]) || 0; 
    const costoEmpleado = parseFloat(issue.fields[process.env.COSTOA_FIELD_ID]) || 0;  
    const organizationsField = issue.fields['customfield_10002'];

    if (!organizationsField || organizationsField.length === 0) {
      console.log(`[CÁLCULO] Ticket sin organización. No se puede calcular.`);
      return null;
    }

    const costoBase = costoInicial + costoEmpleado;
    console.log(`[CÁLCULO] Costo Inicial=${costoInicial}, Costo Empleado=${costoEmpleado}. Costo Base=${costoBase}`);
    
    // 2. BUSCAR CONFIGURACIÓN DEL CLIENTE
    const organization = organizationsField[0];
    const allCustomersQuery = await kvs.query().where('key', WhereConditions.beginsWith('cliente-')).getMany();
    const clienteEncontrado = allCustomersQuery.results.find(item => item.value.organizationId === organization.id);
    
    if (!clienteEncontrado || !clienteEncontrado.value.slaPenaltyPercentage) {
      console.log(`[CÁLCULO] No se encontró configuración de penalización (%) para la organización.`);
      await updateJiraFields(issueId, 0, costoBase);
      return costoBase;
    }
    
    const penaltyPercentagePerHour = parseFloat(clienteEncontrado.value.slaPenaltyPercentage);

    // 3. CALCULAR PENALIZACIÓN
    const slaResponse = await api.asApp().requestJira(route`/rest/servicedeskapi/request/${issueId}/sla`);
    const slaData = await slaResponse.json();
    const resolutionSla = slaData.values?.find(sla => sla.name.includes('Time to resolution'));
    
    let totalPenaltyPercentage = 0;
    let costoTotalFinal = costoBase;

    if (resolutionSla?.ongoingCycle?.breached === true) {
      const breachTimeMillis = Math.abs(resolutionSla.ongoingCycle.remainingTime.millis);
      const breachTimeHours = Math.ceil(breachTimeMillis / (1000 * 60 * 60));
      
      totalPenaltyPercentage = breachTimeHours * penaltyPercentagePerHour;
      const montoPenalizacion = costoBase * (totalPenaltyPercentage / 100);
      costoTotalFinal = costoBase - montoPenalizacion;
    }

    // 4. ACTUALIZAR CAMPOS EN JIRA Y DEVOLVER COSTO FINAL
    await updateJiraFields(issueId, totalPenaltyPercentage, costoTotalFinal);
    return costoTotalFinal;

  } catch (error) {
    console.error(`[CÁLCULO] Error calculando costos para ${issueId}:`, error);
    return null;
  }
}

/**
 * Función auxiliar para actualizar los campos en Jira.
 */
async function updateJiraFields(issueId, percentage, totalCost) {
  const finalPercentage = parseFloat(percentage.toFixed(2))*0.01;
  const finalTotalCost = parseFloat(totalCost.toFixed(2));

  const fieldIdForPercentage = process.env.PERCENTAGE_FIELD_ID; 
  const fieldIdForTotalCost = process.env.COSTOT_FIELD_ID;

  try {
    await api.asApp().requestJira(route`/rest/api/3/issue/${issueId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: { [fieldIdForPercentage]: finalPercentage }
      })
    });
    console.log(`[CÁLCULO] Campo 'Porcentaje de penalización' actualizado en ticket ${issueId}.`);
  } catch (e) {
    console.warn(`[CÁLCULO] No se pudo actualizar el campo de porcentaje en ${issueId}. Es posible que no exista para este tipo de solicitud.`);
  }

  try {
    await api.asApp().requestJira(route`/rest/api/3/issue/${issueId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: { [fieldIdForTotalCost]: finalTotalCost }
      })
    });
    console.log(`[CÁLCULO] Campo 'Costo total' actualizado en ticket ${issueId}.`);
  } catch (e) {
    console.warn(`[CÁLCULO] No se pudo actualizar el campo de costo total en ${issueId}.`);
  }
}


// --- HANDLER DEL BOTÓN (SIMPLIFICADO) ---
export const slaPenaltyHandler = async (event, context) => {
  const issue_context = event.context?.extension?.issue || event?.issue;
  if (!issue_context) {
    console.error("No se pudo obtener el contexto del ticket.");
    return;
  }
  await calculateAndUpdateCosts(issue_context.id);
};
