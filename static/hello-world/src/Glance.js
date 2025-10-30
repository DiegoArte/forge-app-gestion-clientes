// static/hello-world/src/Glance.js

import React, { useState } from 'react';
import { invoke, router } from '@forge/bridge';
import Button from '@atlaskit/button';

export default function Glance() {
  const [isLoading, setIsLoading] = useState(false);

  const handleCalculateClick = async () => {
    setIsLoading(true);
    await invoke('sla-penalty-function');
    router.reload();
  };

  return (
    <div>
      <Button
        appearance="default"
        onClick={handleCalculateClick}
        isDisabled={isLoading}
      >
        {isLoading ? 'Calculando...' : 'Calcular Penalización'}
      </Button>
    </div>
  );
}