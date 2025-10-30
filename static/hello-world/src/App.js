import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@forge/bridge';
import './App.css';

const INITIAL_FORM_STATE = {
  name: '',
  tipoServicio: '',
  vigenciaInicio: '', 
  vigenciaFin: '',
  presupuesto: '',
  slaPenaltyPercentage: '',
  requestTypePermissions: {
    mode: 'all',
    restrictedIds: [],
  },
};

export default function App() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCustomerId, setEditingCustomerId] = useState(null);
  const [formData, setFormData] = useState(INITIAL_FORM_STATE);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [allRequestTypes, setAllRequestTypes] = useState([]);

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handlePermissionModeChange = (mode) => {
    setFormData(prev => ({
      ...prev,
      requestTypePermissions: { ...(prev.requestTypePermissions || { restrictedIds: [] }), mode }
    }));
  };

  const toggleRestrictedType = (id) => {
    setFormData(prev => {
      const currentRestricted = prev.requestTypePermissions.restrictedIds || [];
      const newRestricted = currentRestricted.includes(id)
        ? currentRestricted.filter(typeId => typeId !== id)
        : [...currentRestricted, id];
      return {
        ...prev,
        requestTypePermissions: { ...prev.requestTypePermissions, restrictedIds: newRestricted }
      };
    });
  };

  const openModalForNew = () => {
    setEditingCustomerId(null);
    setFormData(INITIAL_FORM_STATE);
    setIsModalOpen(true);
  };

  const openModalForEdit = (customer) => {
    setEditingCustomerId(customer.id);
    const fullFormData = {
      ...INITIAL_FORM_STATE,
      ...customer,
      requestTypePermissions: customer.requestTypePermissions || INITIAL_FORM_STATE.requestTypePermissions
    };
    setFormData(fullFormData);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingCustomerId(null);
  };

  const fetchRows = async () => {
    setLoading(true);
    const resp = await invoke('resolver', { action: 'listCustomers' });
    if (resp?.ok) setRows(resp.rows || []);
    setLoading(false);
  };

  const fetchRequestTypes = async () => {
    const resp = await invoke('resolver', { action: 'getRequestTypes' });
    if (resp?.ok) setAllRequestTypes(resp.requestTypes || []);
  };
  
  useEffect(() => {
    fetchRows();
    fetchRequestTypes();
  }, []);

  const onSave = async () => {
    console.log('[DEBUG] Intentando guardar. ID de edición:', editingCustomerId);
    // --- LÓGICA DE DECISIÓN: EDITAR O CREAR ---
    if (editingCustomerId) {
      const resp = await invoke('resolver', {
        action: 'updateCustomer',
        payload: { customerId: editingCustomerId, updatedData: formData }
      });
      if (resp?.ok) {
        closeModal();
        fetchRows();
      } else {
        alert(`Error al actualizar: ${resp?.error || ''}`);
      }
    } else {
      const resp = await invoke('resolver', {
        action: 'saveCustomer',
        payload: formData
      });
      if (resp?.ok) {
        closeModal();
        fetchRows();
      } else {
        alert(`Error al registrar: ${resp?.error || ''}`);
      }
    }
  };

  const fmtMoney = (v) => (Number(v) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  const todayISO = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const getVigenciaStatus = (inicio, fin) => {
    if (!inicio || !fin) return { text: '—', className: '' };
    if (todayISO < inicio) return { text: `Inicia: ${inicio}`, className: '' };
    if (todayISO > fin) return { text: `Expirado: ${fin}`, className: 'badge-expired' };
    return { text: `Vigente hasta: ${fin}`, className: 'badge-active' };
  };

  return (
    <>
      <div className="header-container">
        <h1 className="main-title">Listado de clientes</h1>
        <button className="btn-nuevo" onClick={openModalForNew}>+ Nuevo</button>
      </div>

      <div className="content-area">
        {loading ? <p>Cargando clientes…</p> : (
          <table className="customers-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Nombre</th>
                <th>Tipo de servicio</th>
                <th>Vigencia</th>
                <th>Presupuesto</th>
                <th>Tipos de solicitudes</th>
                <th>Penalización SLA (%)</th>
                <th>Editar</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const vigencia = getVigenciaStatus(r.vigenciaInicio, r.vigenciaFin);
                return (
                <tr key={r.id}>
                  <td>{r.id.split('-')[1]}</td>
                  <td>{r.name}</td>
                  <td>{r.tipoServicio || '—'}</td>
                  <td><span className={vigencia.className}>{vigencia.text}</span></td>
                  <td>{r.presupuesto ? fmtMoney(r.presupuesto) : '—'}</td>
                  <td>{r.requestTypePermissions?.mode === 'all' ? 'Todos' : `Todos excepto: ${r.requestTypePermissions?.restrictedIds?.length || 0}`}</td>
                  <td>{r.slaPenaltyPercentage ? `${r.slaPenaltyPercentage}%` : '—'}</td>
                  <td>
                    <button className="btn-icon" title="Editar" onClick={() => openModalForEdit(r)}>✎</button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {isModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h2>{editingCustomerId ? 'Editar cliente' : 'Nuevo cliente'}</h2>
              <button className="close-button" onClick={closeModal}>×</button>
            </div>
            <div className="modal-body">
              <div className="form-row">
                <label>Nombre
                  <input type="text" name="name" className="form-input" value={formData.name || ''} onChange={handleInputChange} disabled={!!editingCustomerId} />
                </label>
                <label>Tipo de servicio
                  <input type="text" name="tipoServicio" className="form-input" value={formData.tipoServicio || ''} onChange={handleInputChange} />
                </label>
              </div>
              <div className="form-row">
                <label>Inicio de contrato
                  <input type="date" name="vigenciaInicio" className="form-input" value={formData.vigenciaInicio || ''} onChange={handleInputChange} />
                </label>
                <label>Fin de contrato
                  <input type="date" name="vigenciaFin" className="form-input" value={formData.vigenciaFin || ''} onChange={handleInputChange} />
                </label>
              </div>
              <div className="form-row">
                <label>Presupuesto
                  <input type="number" name="presupuesto" className="form-input" value={formData.presupuesto || ''} onChange={handleInputChange} />
                </label>
                <label>Porcentaje de penalización SLA (%)
                  <input type="number" name="slaPenaltyPercentage" className="form-input" value={formData.slaPenaltyPercentage || ''} onChange={handleInputChange} placeholder="Ej: 10" />
                </label>
              </div>
              <div className="permission-section">
                <label className="permission-title">Permisos de tipos de solicitud</label>
                <div className="radio-group">
                  <label>
                    <input type="radio" value="all" checked={formData.requestTypePermissions?.mode === 'all'} onChange={() => handlePermissionModeChange('all')} />
                    Permitir todos los tipos de solicitud
                  </label>
                  <label>
                    <input type="radio" value="except" checked={formData.requestTypePermissions?.mode === 'except'} onChange={() => handlePermissionModeChange('except')} />
                    Permitir todos EXCEPTO:
                  </label>
                </div>
                {formData.requestTypePermissions?.mode === 'except' && (
                  <div className="checkbox-grid">
                    {allRequestTypes.map(rt => (
                      <label key={rt.id} className="checkbox-label">
                        <input type="checkbox" checked={formData.requestTypePermissions?.restrictedIds?.includes(rt.id)} onChange={() => toggleRestrictedType(rt.id)} />
                        {`(${rt.projectKey}): ${rt.name}`}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-register" onClick={onSave}>{editingCustomerId ? 'Guardar cambios' : 'Registrar'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}