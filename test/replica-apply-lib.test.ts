/**
 * Unit tests for the Collection Metadata merge of the replica apply path
 * (`mergeAppliedCollectionMetadata`): the fork text names the side that holds
 * each object, in the default direction and in the one the registration
 * check passes.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'

import { mergeAppliedCollectionMetadata } from '../src/lib/replicaApply.js'
import type { CollectionMetadata } from '../src/types.js'

const plain = {} as CollectionMetadata
const encrypted = { encryption: { scheme: 'edv' } } as CollectionMetadata
const writeOnce = { revisions: { immutable: true } } as CollectionMetadata
const peerHeld = { held: 'on the peer', incoming: 'here' }

describe('mergeAppliedCollectionMetadata fork text', () => {
  it('names the peer as the declaring side by default', () => {
    assert.deepStrictEqual(
      mergeAppliedCollectionMetadata({ held: plain, incoming: encrypted }),
      { fork: '"encryption" is declared on the peer and absent here.' }
    )
    assert.deepStrictEqual(
      mergeAppliedCollectionMetadata({ held: plain, incoming: writeOnce }),
      { fork: '"revisions.immutable" is true on the peer and absent here.' }
    )
  })

  it('names this server as the declaring side when the peer object is held', () => {
    assert.deepStrictEqual(
      mergeAppliedCollectionMetadata({
        held: plain,
        incoming: encrypted,
        sides: peerHeld
      }),
      { fork: '"encryption" is declared here and absent on the peer.' }
    )
    assert.deepStrictEqual(
      mergeAppliedCollectionMetadata({
        held: plain,
        incoming: writeOnce,
        sides: peerHeld
      }),
      { fork: '"revisions.immutable" is true here and absent on the peer.' }
    )
  })

  it('keeps a held member the received object omits', () => {
    assert.deepStrictEqual(
      mergeAppliedCollectionMetadata({ held: encrypted, incoming: plain }),
      { metadata: encrypted }
    )
  })
})
