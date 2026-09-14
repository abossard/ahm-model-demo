targetScope = 'resourceGroup'

@description('Name of the fictional shop Azure Health Model.')
param modelName string

@description('Region hosting the Azure Health Model.')
param healthModelLocation string

@description('Existing container app backing simulated shop services.')
param containerAppId string

@description('Existing AKS cluster backing product and cart service roles.')
param aksClusterId string

@description('Existing PostgreSQL server backing the logical shop database roles.')
param postgresId string

@description('Existing storage account backing shared storage and the queue service.')
param storageId string

@description('Log Analytics workspace the synthetic demo signals are evaluated against.')
param workspaceId string

@description('Tags applied to all taggable resources.')
param tags object

var authenticationName = 'auth-system'
var orderQueueServiceId = '${storageId}/queueServices/default'

// Synthetic demo health: a constant record keeps every shop leaf Healthy without workload traffic
// or expiring health reports. It does not describe the bound resource's real condition.
var syntheticDemoSignals = [
  {
    name: 'synthetic-demo-health'
    displayName: 'Synthetic demo health (constant 100)'
    signalKind: 'LogAnalyticsQuery'
    queryText: 'print Value = 100'
    valueColumnName: 'Value'
    dataUnit: 'Count'
    timeGrain: 'PT5M'
    refreshInterval: 'PT5M'
    evaluationRules: {
      unhealthyRule: {
        operator: 'GreaterThan'
        threshold: 100
      }
    }
  }
]

resource model 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' = {
  name: modelName
  location: healthModelLocation
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {}
}

resource authentication 'Microsoft.CloudHealth/healthmodels/authenticationsettings@2026-05-01-preview' = {
  parent: model
  name: authenticationName
  properties: {
    displayName: 'Shop health model system identity'
    authenticationKind: 'ManagedIdentity'
    managedIdentityName: 'SystemAssigned'
  }
}

module access 'health-model-access.bicep' = {
  name: 'shop-health-model-access'
  params: {
    modelPrincipalId: model.identity.principalId
    monitoredResources: {
      storefront: containerAppId
      products: aksClusterId
      ordersDatabase: postgresId
      storage: storageId
      orderQueue: orderQueueServiceId
      logAnalyticsWorkspace: workspaceId
    }
  }
}

// Row 0 - the model root. Ten logical entities aggregate WorstOf without ignoring Unknown, so a leaf
// that stops evaluating surfaces here instead of being silently dropped.
resource root 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: modelName
  properties: {
    displayName: 'Contoso Shop'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 1270
      y: 0
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    }
  }
}

// Row 193 - the three shop flows.
resource checkout 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'checkout'
  properties: {
    displayName: 'Checkout'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 1780
      y: 193
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    }
  }
}

resource shopping 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'shopping'
  properties: {
    displayName: 'Shopping'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 1260
      y: 193
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    }
  }
}

resource orders 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'orders'
  properties: {
    displayName: 'Orders'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 750
      y: 193
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    }
  }
}

// Row 386 - the six shop services.
resource payment 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'payment'
  properties: {
    displayName: 'Payments'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 1780
      y: 386
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    }
  }
}

resource shoppingCart 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'shopping-cart'
  properties: {
    displayName: 'Shopping Cart'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 1385
      y: 386
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    }
  }
}

resource productCatalog 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'product-catalog'
  properties: {
    displayName: 'Product Catalog'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 375
      y: 386
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    }
  }
}

resource inventory 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'inventory'
  properties: {
    displayName: 'Inventory'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 750
      y: 386
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    }
  }
}

resource orderProcessing 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'order-processing'
  properties: {
    displayName: 'Order Processing'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 125
      y: 386
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    }
  }
}

resource analytics 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'analytics'
  properties: {
    displayName: 'Analytics'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 1135
      y: 386
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    }
  }
}

// Simulated external payment providers. They carry the synthetic signal but bind no Azure
// resource, because the demo does not integrate a real provider.
resource providerStripe 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'provider-stripe'
  properties: {
    displayName: 'Stripe (simulated external)'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 1655
      y: 597
    }
    signalGroups: {
      azureLogAnalytics: {
        authenticationSetting: authentication.name
        logAnalyticsWorkspaceResourceId: access.outputs.monitoredResources.logAnalyticsWorkspace
        signals: syntheticDemoSignals
      }
    }
  }
}

resource providerPaypal 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'provider-paypal'
  properties: {
    displayName: 'PayPal (simulated external)'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 1905
      y: 597
    }
    signalGroups: {
      azureLogAnalytics: {
        authenticationSetting: authentication.name
        logAnalyticsWorkspaceResourceId: access.outputs.monitoredResources.logAnalyticsWorkspace
        signals: syntheticDemoSignals
      }
    }
  }
}

// The six real Azure resources, bound through the access module's outputs so the read
// grants exist before any entity does.
resource azurePostgres 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'azure-postgres'
  properties: {
    displayName: '${last(split(postgresId, '/'))} (Microsoft.DBforPostgreSQL/flexibleServers)'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 625
      y: 579
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authentication.name
        azureResourceId: access.outputs.monitoredResources.ordersDatabase
        azureResourceKind: 'PostgreSQLFlexibleServer'
        resourceHealth: {
          enabled: 'Disabled'
        }
      }
      azureLogAnalytics: {
        authenticationSetting: authentication.name
        logAnalyticsWorkspaceResourceId: access.outputs.monitoredResources.logAnalyticsWorkspace
        signals: syntheticDemoSignals
      }
    }
  }
}

resource azureAks 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'azure-aks'
  properties: {
    displayName: '${last(split(aksClusterId, '/'))} (Microsoft.ContainerService/managedClusters)'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 1405
      y: 589
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authentication.name
        azureResourceId: access.outputs.monitoredResources.products
        azureResourceKind: 'AksCluster'
        resourceHealth: {
          enabled: 'Disabled'
        }
      }
      azureLogAnalytics: {
        authenticationSetting: authentication.name
        logAnalyticsWorkspaceResourceId: access.outputs.monitoredResources.logAnalyticsWorkspace
        signals: syntheticDemoSignals
      }
    }
  }
}

resource azureWeb 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'azure-web'
  properties: {
    displayName: '${last(split(containerAppId, '/'))} (Microsoft.App/containerApps)'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 0
      y: 589
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authentication.name
        azureResourceId: access.outputs.monitoredResources.storefront
        azureResourceKind: 'ContainerApp'
        resourceHealth: {
          enabled: 'Disabled'
        }
      }
      azureLogAnalytics: {
        authenticationSetting: authentication.name
        logAnalyticsWorkspaceResourceId: access.outputs.monitoredResources.logAnalyticsWorkspace
        signals: syntheticDemoSignals
      }
    }
  }
}

resource azureQueue 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'azure-queue'
  properties: {
    displayName: '${last(split(storageId, '/'))}/default (Microsoft.Storage/storageAccounts/queueServices)'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 250
      y: 579
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authentication.name
        azureResourceId: access.outputs.monitoredResources.orderQueue
        azureResourceKind: 'StorageAccount'
        resourceHealth: {
          enabled: 'Disabled'
        }
      }
      azureLogAnalytics: {
        authenticationSetting: authentication.name
        logAnalyticsWorkspaceResourceId: access.outputs.monitoredResources.logAnalyticsWorkspace
        signals: syntheticDemoSignals
      }
    }
  }
}

resource azureStorage 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'azure-storage'
  properties: {
    displayName: '${last(split(storageId, '/'))} (Microsoft.Storage/storageAccounts)'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 885
      y: 589
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authentication.name
        azureResourceId: access.outputs.monitoredResources.storage
        azureResourceKind: 'StorageAccount'
        resourceHealth: {
          enabled: 'Disabled'
        }
      }
      azureLogAnalytics: {
        authenticationSetting: authentication.name
        logAnalyticsWorkspaceResourceId: access.outputs.monitoredResources.logAnalyticsWorkspace
        signals: syntheticDemoSignals
      }
    }
  }
}

resource azureWorkspace 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'azure-workspace'
  properties: {
    displayName: '${last(split(workspaceId, '/'))} (Microsoft.OperationalInsights/workspaces)'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 1135
      y: 589
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authentication.name
        azureResourceId: access.outputs.monitoredResources.logAnalyticsWorkspace
        azureResourceKind: 'LogAnalyticsWorkspace'
        resourceHealth: {
          enabled: 'Disabled'
        }
      }
      azureLogAnalytics: {
        authenticationSetting: authentication.name
        logAnalyticsWorkspaceResourceId: access.outputs.monitoredResources.logAnalyticsWorkspace
        signals: syntheticDemoSignals
      }
    }
  }
}

// Root to flows.
resource relRootShopping 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-root-shopping'
  properties: {
    parentEntityName: root.name
    childEntityName: shopping.name
  }
}

resource relRootCheckout 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-root-checkout'
  properties: {
    parentEntityName: root.name
    childEntityName: checkout.name
  }
}

resource relRootOrders 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-root-orders'
  properties: {
    parentEntityName: root.name
    childEntityName: orders.name
  }
}

// Flows to services.
resource relShoppingProductCatalog 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-shopping-product-catalog'
  properties: {
    parentEntityName: shopping.name
    childEntityName: productCatalog.name
  }
}

resource relShoppingShoppingCart 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-shopping-shopping-cart'
  properties: {
    parentEntityName: shopping.name
    childEntityName: shoppingCart.name
  }
}

resource relCheckoutShoppingCart 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-checkout-shopping-cart'
  properties: {
    parentEntityName: checkout.name
    childEntityName: shoppingCart.name
  }
}

resource relCheckoutPayment 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-checkout-payment'
  properties: {
    parentEntityName: checkout.name
    childEntityName: payment.name
  }
}

resource relOrdersOrderProcessing 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-orders-order-processing'
  properties: {
    parentEntityName: orders.name
    childEntityName: orderProcessing.name
  }
}

resource relOrdersInventory 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-orders-inventory'
  properties: {
    parentEntityName: orders.name
    childEntityName: inventory.name
  }
}

resource relOrdersAnalytics 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-orders-analytics'
  properties: {
    parentEntityName: orders.name
    childEntityName: analytics.name
  }
}

// Services to the resources and providers that back them.
resource relProductCatalogAzureWeb 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-product-catalog-azure-web'
  properties: {
    parentEntityName: productCatalog.name
    childEntityName: azureWeb.name
  }
}

resource relProductCatalogAzurePostgres 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-product-catalog-azure-postgres'
  properties: {
    parentEntityName: productCatalog.name
    childEntityName: azurePostgres.name
  }
}

resource relShoppingCartAzureAks 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-shopping-cart-azure-aks'
  properties: {
    parentEntityName: shoppingCart.name
    childEntityName: azureAks.name
  }
}

resource relShoppingCartAzureStorage 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-shopping-cart-azure-storage'
  properties: {
    parentEntityName: shoppingCart.name
    childEntityName: azureStorage.name
  }
}

resource relInventoryAzurePostgres 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-inventory-azure-postgres'
  properties: {
    parentEntityName: inventory.name
    childEntityName: azurePostgres.name
  }
}

resource relOrderProcessingAzureWeb 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-order-processing-azure-web'
  properties: {
    parentEntityName: orderProcessing.name
    childEntityName: azureWeb.name
  }
}

resource relOrderProcessingAzureQueue 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-order-processing-azure-queue'
  properties: {
    parentEntityName: orderProcessing.name
    childEntityName: azureQueue.name
  }
}

resource relPaymentProviderStripe 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-payment-provider-stripe'
  properties: {
    parentEntityName: payment.name
    childEntityName: providerStripe.name
  }
}

resource relPaymentProviderPaypal 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-payment-provider-paypal'
  properties: {
    parentEntityName: payment.name
    childEntityName: providerPaypal.name
  }
}

resource relPaymentAzureAks 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-payment-azure-aks'
  properties: {
    parentEntityName: payment.name
    childEntityName: azureAks.name
  }
}

resource relAnalyticsAzureWorkspace 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-shop-analytics-azure-workspace'
  properties: {
    parentEntityName: analytics.name
    childEntityName: azureWorkspace.name
  }
}

output modelId string = model.id
output modelName string = model.name
output modelPrincipalId string = model.identity.principalId
output entityNames array = [
  root.name
  shopping.name
  checkout.name
  orders.name
  payment.name
  shoppingCart.name
  productCatalog.name
  inventory.name
  orderProcessing.name
  analytics.name
  providerStripe.name
  providerPaypal.name
  azurePostgres.name
  azureAks.name
  azureWeb.name
  azureQueue.name
  azureStorage.name
  azureWorkspace.name
]
