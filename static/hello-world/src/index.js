
import React from 'react';
import ReactDOM from 'react-dom';
import { view } from '@forge/bridge';

import App from './App';       
import Glance from './Glance'; 

import '@atlaskit/css-reset';

const renderApp = async () => {
  try {
    const context = await view.getContext();
    const moduleKey = context.moduleKey;
    let ComponentToRender;

    switch (moduleKey) {
      case 'residenciaapp-hello-world-page':
        ComponentToRender = App;
        break;
      case 'sla-penalty-glance':
        ComponentToRender = Glance;
        break;
      default:
        ComponentToRender = App;
        break;
    }

    ReactDOM.render(
      <React.StrictMode>
        <ComponentToRender />
      </React.StrictMode>,
      document.getElementById('root')
    );
  } catch (error) {
    console.error("Error al obtener el contexto de Forge:", error);
    ReactDOM.render(<p>Error al cargar la aplicación.</p>, document.getElementById('root'));
  }
};

renderApp();