import { kvs, WhereConditions } from '@forge/kvs';
import api, { route } from "@forge/api";


async function createAndAssociateOrganization(organizationName) {
  console.log(`Creando y asociando la organización: '${organizationName}'`);

  // 1. Crear la organización primero
  const createOrgResponse = await api.asApp().requestJira(route`/rest/servicedeskapi/organization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: organizationName }),
  });

  if (!createOrgResponse.ok) {
    const errorText = await createOrgResponse.text();
    throw new Error(`Error al crear la organización: ${errorText}`);
  }

  const newOrganization = await createOrgResponse.json();
  const organizationId = newOrganization.id;
  console.log(`-> Organización creada con ID: ${organizationId}`);

  // 2. Obtener todos los proyectos y filtrar los de JSM
  const projectResponse = await api.asApp().requestJira(route`/rest/api/3/project/search`);
  const projectData = await projectResponse.json();
  const jsmProjects = projectData.values.filter(project => project.projectTypeKey === 'service_desk');
  console.log(`-> Encontrados ${jsmProjects.length} proyectos de JSM para asociar.`);

  // 3. Asociar la organización a cada proyecto de JSM
  for (const project of jsmProjects) {
    const serviceDeskId = project.id;
    try {
      await api.asApp().requestJira(route`/rest/servicedeskapi/servicedesk/${serviceDeskId}/organization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId }),
      });
      console.log(`-> Asociación exitosa con el proyecto '${project.name}'`);
    } catch (error) {
      console.error(`Error al asociar con '${project.name}':`, await error.response.text());
    }
  }

  return newOrganization;
}

// --- FUNCIÓN AUXILIAR PARA OBTENER TODOS LOS TIPOS DE SOLICITUD ---
async function getAllRequestTypes() {
  const allRequestTypes = [];

  // 1. Obtenemos una lista de TODOS los Service Desks primero.
  const serviceDesksRes = await api.asApp().requestJira(route`/rest/servicedeskapi/servicedesk`);
  const serviceDesksData = await serviceDesksRes.json();
  
  if (!serviceDesksData.values || serviceDesksData.values.length === 0) {
    console.log('[BACKEND] No se encontró ningún Service Desk en la instancia.');
    return [];
  }

  // 2. Recorremos cada Service Desk para obtener sus tipos de solicitud.
  for (const sd of serviceDesksData.values) {
    const serviceDeskId = sd.id;
    const projectId = sd.projectId;
    const projectKey = sd.projectKey;
    
    try {
      const requestTypesRes = await api.asApp().requestJira(route`/rest/servicedeskapi/servicedesk/${serviceDeskId}/requesttype`);
      const requestTypesData = await requestTypesRes.json();
      
      if (requestTypesData.values) {
        requestTypesData.values.forEach(rt => {
          allRequestTypes.push({
            id: rt.id,
            name: rt.name,
            projectId: projectId,
            projectKey: projectKey,
          });
        });
      }
    } catch (e) {
      console.warn(`No se pudieron obtener los tipos de solicitud para el Service Desk ${serviceDeskId}`, e);
    }
  }

  console.log(`[BACKEND-FINAL] Se encontraron un total de ${allRequestTypes.length} tipos de solicitud.`);
  return allRequestTypes;
}

// ---- handler principal ----
export const handler = async (req, ctx) => {
  const { action, payload } = req?.call?.payload || {};

  console.log(`Acción detectada: ${action}`);
  try {

    if (action === 'getRequestTypes') {
      const requestTypes = await getAllRequestTypes();
      return { ok: true, requestTypes };
    }

    // --- ACCIÓN PARA GUARDAR UN CLIENTE ---
    if (action === 'saveCustomer' || action === 'updateCustomer') {
      let customerId;
      let oldData = {};
      
      const { name, tipoServicio, vigenciaInicio, vigenciaFin, presupuesto, requestTypePermissions, slaPenaltyPercentage } = payload.updatedData || payload;

      if (action === 'updateCustomer') {
        customerId = payload.customerId;
        oldData = await kvs.get(customerId);
      } else { // saveCustomer
        if (!name?.trim()) throw new Error('El campo "Nombre" es obligatorio.');
        const organizationData = await createAndAssociateOrganization(name.trim());
        oldData.organizationId = organizationData.id; 
        customerId = `cliente-${Date.now()}`;
      }
      
      const clienteData = {
        ...oldData,
        name: name.trim(),
        tipoServicio,
        vigenciaInicio, 
        vigenciaFin,    
        presupuesto,
        requestTypePermissions,
        slaPenaltyPercentage,
      };

      await kvs.set(customerId, clienteData);
      return { ok: true, id: customerId };
    }

    // --- ACCIÓN PARA LISTAR TODOS LOS CLIENTES ---
    if (action === 'listCustomers') {
      // 1. Obtenemos todos los registros de la entidad 'clientes'.
      const queryResult = await kvs.query()
        .where('key', WhereConditions.beginsWith('cliente-'))
        .limit(10)
        .getMany();

      if (!queryResult || !queryResult.results) {
        return { ok: false, error: 'No se encontraron clientes.' };
      }
      
      // 2. Transformamos los resultados al formato que el frontend espera.
      const rows = queryResult.results.map(item => {
        return {
          id: item.key, 
          ...item.value,   
        };
      });

      console.log(`Se encontraron ${rows.length} clientes.`);
      return { ok: true, rows };
    }


    if (action) {
      console.warn(`Acción desconocida: ${action}`);
    }

    return { ok: true };

  } catch (e) {
    console.error('HANDLER ERROR', e);
    return { ok: false, error: String(e.message || e) };
  }
};

