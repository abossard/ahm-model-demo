targetScope = 'resourceGroup'

@description('Name of the separate IoT factory load-test health model.')
param modelName string

@description('Region hosting the Azure Health Model.')
param healthModelLocation string

@description('Tags applied to all taggable resources.')
param tags object

@description('Resource IDs from this azd environment.')
param monitoredResources object

@minValue(8000)
@maxValue(8000)
@description('Number of entities in the supported IoT factory profile.')
param entityCount int = 8000

@minValue(20)
@maxValue(20)
@description('Number of semantic levels in the supported IoT factory profile.')
param levelCount int = 20

@minValue(22)
@maxValue(400)
@description('Resource count in each batch, bounded to keep nested deployments under ARM limits.')
param batchSize int = 400

type LayerSpec = {
  name: string
  level: int
  firstIndex: int
  count: int
}

type RelationshipSpec = {
  name: string
  parentIndex: int
  childIndex: int
  displayName: string
}

func layerFor(index int, depth int, layers LayerSpec[]) LayerSpec => first(filter(layers, layer => index >= layer.firstIndex && index < layer.firstIndex + layer.count && layer.level < depth)) ?? layers[0]

func primaryParentIndex(index int, depth int, layers LayerSpec[]) int => layers[layerFor(index, depth, layers).level - 1].firstIndex + ((index - layerFor(index, depth, layers).firstIndex) * layers[layerFor(index, depth, layers).level - 1].count / layerFor(index, depth, layers).count)

func relationshipAt(index int, entities int, depth int, layers LayerSpec[]) RelationshipSpec => {
  name: index < entities - 1 ? format('primary-{0}-{1}', primaryParentIndex(index + 1, depth, layers), index + 1) : format('cross-{0}', index - (entities - 1))
  parentIndex: index < entities - 1 ? primaryParentIndex(index + 1, depth, layers) : 1000 + index - (entities - 1)
  childIndex: index < entities - 1 ? index + 1 : 7200 + index - (entities - 1)
  displayName: index < entities - 1 ? 'contains' : 'shares telemetry with'
}

var layerSpecs = [
  {
    name: 'portfolio'
    level: 0
    firstIndex: 0
    count: 1
  }
  {
    name: 'regions'
    level: 1
    firstIndex: 1
    count: 2
  }
  {
    name: 'countries'
    level: 2
    firstIndex: 3
    count: 4
  }
  {
    name: 'factory-sites'
    level: 3
    firstIndex: 7
    count: 8
  }
  {
    name: 'campuses'
    level: 4
    firstIndex: 15
    count: 16
  }
  {
    name: 'plants'
    level: 5
    firstIndex: 31
    count: 32
  }
  {
    name: 'buildings'
    level: 6
    firstIndex: 63
    count: 64
  }
  {
    name: 'production-halls'
    level: 7
    firstIndex: 127
    count: 128
  }
  {
    name: 'production-lines'
    level: 8
    firstIndex: 255
    count: 256
  }
  {
    name: 'work-cells'
    level: 9
    firstIndex: 511
    count: 512
  }
  {
    name: 'machine-islands'
    level: 10
    firstIndex: 1023
    count: 512
  }
  {
    name: 'machines'
    level: 11
    firstIndex: 1535
    count: 512
  }
  {
    name: 'machine-controllers'
    level: 12
    firstIndex: 2047
    count: 512
  }
  {
    name: 'plcs'
    level: 13
    firstIndex: 2559
    count: 512
  }
  {
    name: 'sensor-gateways'
    level: 14
    firstIndex: 3071
    count: 512
  }
  {
    name: 'device-racks'
    level: 15
    firstIndex: 3583
    count: 512
  }
  {
    name: 'devices'
    level: 16
    firstIndex: 4095
    count: 512
  }
  {
    name: 'sensors'
    level: 17
    firstIndex: 4607
    count: 512
  }
  {
    name: 'telemetry-channels'
    level: 18
    firstIndex: 5119
    count: 512
  }
  {
    name: 'observations'
    level: 19
    firstIndex: 5631
    count: 2369
  }
]

var relationshipCount = entityCount - 1 + 800
var entityBatchCount = (entityCount + batchSize - 1) / batchSize
var relationshipBatchCount = (relationshipCount + batchSize - 1) / batchSize

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
  name: 'auth-system'
  properties: {
    displayName: 'Health model system identity'
    authenticationKind: 'ManagedIdentity'
    managedIdentityName: 'SystemAssigned'
  }
}

module healthModelAccess '../modules/health-model-access.bicep' = {
  name: 'health-model-access'
  params: {
    modelPrincipalId: model.identity.principalId
    monitoredResources: monitoredResources
  }
}

module signalDefinitions 'signal-definitions.bicep' = {
  name: 'signal-definitions'
  params: {
    modelName: model.name
    authenticationSettingName: authentication.name
    monitoredResources: healthModelAccess.outputs.monitoredResources
  }
}

module entityBatch 'entity-batch.bicep' = [for batchIndex in range(0, entityBatchCount): {
  name: format('iot-factory-entities-{0}', batchIndex)
  params: {
    modelName: model.name
    entities: [
      for localIndex in range(0, min(batchSize, entityCount - batchIndex * batchSize)): {
        name: format(
          '{0}-{1}',
          layerFor(batchIndex * batchSize + localIndex, levelCount, layerSpecs).name,
          batchIndex * batchSize + localIndex - layerFor(batchIndex * batchSize + localIndex, levelCount, layerSpecs).firstIndex
        )
        displayName: format(
          '{0} {1}',
          layerFor(batchIndex * batchSize + localIndex, levelCount, layerSpecs).name,
          batchIndex * batchSize + localIndex - layerFor(batchIndex * batchSize + localIndex, levelCount, layerSpecs).firstIndex + 1
        )
        index: batchIndex * batchSize + localIndex
        level: layerFor(batchIndex * batchSize + localIndex, levelCount, layerSpecs).level
        localIndex: batchIndex * batchSize + localIndex - layerFor(batchIndex * batchSize + localIndex, levelCount, layerSpecs).firstIndex
      }
    ]
    signalProfiles: signalDefinitions.outputs.signalProfiles
  }
}]

module relationshipBatch 'relationship-batch.bicep' = [for batchIndex in range(0, relationshipBatchCount): {
  name: format('iot-factory-relationships-{0}', batchIndex)
  params: {
    modelName: model.name
    relationships: [
      for localIndex in range(0, min(batchSize, relationshipCount - batchIndex * batchSize)): {
        name: relationshipAt(batchIndex * batchSize + localIndex, entityCount, levelCount, layerSpecs).name
        parentEntityName: entityBatch[relationshipAt(batchIndex * batchSize + localIndex, entityCount, levelCount, layerSpecs).parentIndex / batchSize].outputs.entityNames[relationshipAt(batchIndex * batchSize + localIndex, entityCount, levelCount, layerSpecs).parentIndex % batchSize]
        childEntityName: entityBatch[relationshipAt(batchIndex * batchSize + localIndex, entityCount, levelCount, layerSpecs).childIndex / batchSize].outputs.entityNames[relationshipAt(batchIndex * batchSize + localIndex, entityCount, levelCount, layerSpecs).childIndex % batchSize]
        displayName: relationshipAt(batchIndex * batchSize + localIndex, entityCount, levelCount, layerSpecs).displayName
      }
    ]
  }
}]
