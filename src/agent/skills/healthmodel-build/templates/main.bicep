// Starter health model (API 2026-11-01): shows each building block once.
// Replace the example storefront entities, signals and thresholds with the ones from the plan.
// Reference: https://learn.microsoft.com/azure/templates/microsoft.cloudhealth/2026-11-01/healthmodels

@minLength(3)
@maxLength(44)
param healthModelName string

@description('A region where Microsoft.CloudHealth is available: az provider show -n Microsoft.CloudHealth')
param location string

@description('Resource ID of the App Service that serves the storefront API')
param apiAppServiceId string

@description('Resource ID of the Azure Cache for Redis instance')
param cacheId string

@description('Resource ID of the Log Analytics workspace behind Application Insights')
param logAnalyticsWorkspaceId string

@description('Action group resource IDs notified when checkout turns unhealthy (max 5)')
param actionGroupIds array = []

resource healthModel 'Microsoft.CloudHealth/healthmodels@2026-11-01' = {
  name: healthModelName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {}
}

// The model queries metrics and logs with its own identity, and Azure doesn't grant that automatically:
// Reader on monitored resources, Monitoring Reader on queried workspaces.
// These assignments cover this resource group; assign at the right scope if resources live elsewhere.
var monitoringRoleIds = [
  'acdd72a7-3385-48ef-bd42-f606fba81ae7' // Reader
  '43d0d8ad-25c7-4714-9337-8ba259a9fe05' // Monitoring Reader
]

resource modelRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for roleId in monitoringRoleIds: {
    name: guid(resourceGroup().id, healthModel.id, roleId)
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleId)
      principalId: healthModel.identity.principalId
      principalType: 'ServicePrincipal'
    }
  }
]

resource auth 'Microsoft.CloudHealth/healthmodels/authenticationsettings@2026-11-01' = {
  parent: healthModel
  name: 'system-assigned'
  properties: {
    authenticationKind: 'ManagedIdentity'
    managedIdentityName: 'SystemAssigned'
  }
  dependsOn: [
    modelRoles
  ]
}

// Reusable signal definition: changing it changes every entity that uses it.
resource http5xx 'Microsoft.CloudHealth/healthmodels/signaldefinitions@2026-11-01' = {
  parent: healthModel
  name: 'http-5xx'
  properties: {
    signalKind: 'AzureResourceMetric'
    displayName: 'Failed requests (HTTP 5xx)'
    metricNamespace: 'Microsoft.Web/sites'
    metricName: 'Http5xx'
    aggregationType: 'Total'
    timeGrain: 'PT5M'
    refreshInterval: 'PT1M'
    dataUnit: 'Count'
    evaluationRules: {
      degradedRule: {
        operator: 'GreaterThan'
        threshold: 5
      }
      unhealthyRule: {
        operator: 'GreaterThan'
        threshold: 20
      }
    }
  }
}

// Example tree from a plan: user flow -> system components -> Azure resources.

// User flow: a virtual entity without signals.
resource checkout 'Microsoft.CloudHealth/healthmodels/entities@2026-11-01' = {
  parent: healthModel
  name: 'checkout'
  properties: {
    displayName: 'Complete a purchase'
    icon: {
      iconName: 'UserFlow'
    }
    healthObjective: json('99.9')
    alerts: {
      unhealthy: {
        severity: 'Sev1'
        description: 'Customers cannot complete purchases'
        actionGroupIds: actionGroupIds
      }
    }
    signalGroups: {
      // How children roll up into this entity. WorstOf is the default; it doesn't count Unknown children.
      dependencies: {
        aggregationType: 'WorstOf'
      }
    }
  }
}

// System component: a virtual entity with a query on the Log Analytics workspace.
resource storefrontApi 'Microsoft.CloudHealth/healthmodels/entities@2026-11-01' = {
  parent: healthModel
  name: 'storefront-api'
  properties: {
    displayName: 'Storefront API'
    icon: {
      iconName: 'SystemComponent'
    }
    signalGroups: {
      azureLogAnalytics: {
        authenticationSetting: auth.name
        logAnalyticsWorkspaceResourceId: logAnalyticsWorkspaceId
        signals: [
          {
            name: 'failed-api-requests'
            signalKind: 'LogAnalyticsQuery'
            displayName: 'Failed API requests'
            // One row with a number: 0 when nothing failed, also without traffic.
            queryText: '''
              AppRequests
              | where Success == false
              | summarize failedRequests = count()
              '''
            valueColumnName: 'failedRequests'
            timeGrain: 'PT5M'
            refreshInterval: 'PT1M'
            dataUnit: 'Count'
            evaluationRules: {
              degradedRule: {
                operator: 'GreaterThan'
                threshold: 5
              }
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 20
              }
            }
          }
        ]
      }
    }
  }
}

// System component with limited impact: an optional cache passes Unhealthy up as Degraded and Degraded as Healthy.
resource productCache 'Microsoft.CloudHealth/healthmodels/entities@2026-11-01' = {
  parent: healthModel
  name: 'product-cache'
  properties: {
    displayName: 'Product cache (optional)'
    icon: {
      iconName: 'SystemComponent'
    }
    impact: 'Limited'
  }
}

// Azure resource entity, using the shared signal definition.
resource appService 'Microsoft.CloudHealth/healthmodels/entities@2026-11-01' = {
  parent: healthModel
  name: 'app-service'
  properties: {
    displayName: 'App Service: ${last(split(apiAppServiceId, '/'))}'
    signalGroups: {
      azureResource: {
        authenticationSetting: auth.name
        azureResourceId: apiAppServiceId
        signals: [
          {
            name: 'http-5xx'
            signalKind: 'AzureResourceMetric'
            signalDefinitionName: http5xx.name
          }
        ]
      }
    }
  }
}

// Azure resource entity with an inline platform metric.
resource redis 'Microsoft.CloudHealth/healthmodels/entities@2026-11-01' = {
  parent: healthModel
  name: 'redis'
  properties: {
    displayName: 'Azure Cache for Redis: ${last(split(cacheId, '/'))}'
    signalGroups: {
      azureResource: {
        authenticationSetting: auth.name
        azureResourceId: cacheId
        signals: [
          {
            name: 'server-load'
            signalKind: 'AzureResourceMetric'
            displayName: 'Server load'
            metricNamespace: 'Microsoft.Cache/redis'
            metricName: 'serverLoad'
            aggregationType: 'Maximum'
            timeGrain: 'PT5M'
            refreshInterval: 'PT1M'
            dataUnit: 'Percent'
            evaluationRules: {
              degradedRule: {
                operator: 'GreaterThan'
                threshold: 80
              }
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 95
              }
            }
          }
        ]
      }
    }
  }
}

// Health flows from child to parent. The root entity exists already and is named like the model.
var edges = [
  { parent: healthModelName, child: 'checkout' }
  { parent: 'checkout', child: 'storefront-api' }
  { parent: 'checkout', child: 'product-cache' }
  { parent: 'storefront-api', child: 'app-service' }
  { parent: 'product-cache', child: 'redis' }
]

resource relationships 'Microsoft.CloudHealth/healthmodels/relationships@2026-11-01' = [
  for edge in edges: {
    parent: healthModel
    name: '${edge.parent}-${edge.child}'
    properties: {
      parentEntityName: edge.parent
      childEntityName: edge.child
    }
    dependsOn: [
      checkout
      storefrontApi
      productCache
      appService
      redis
    ]
  }
]

output healthModelId string = healthModel.id
output principalId string = healthModel.identity.principalId
