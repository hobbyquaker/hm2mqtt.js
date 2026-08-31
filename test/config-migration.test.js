import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {applyItemTemplates} from '../lib/topics.js';

describe('item template migration', () => {
    test('an item template becomes the pair of topic templates it used to mean', () => {
        const config = applyItemTemplates({
            itemTemplate: '${room}/${channelName}/${datapoint}',
            topicStatus: '${prefix}/status/${channelName|channel}/${datapoint}',
            topicSet: '${prefix}/set/${channelName|channel}/${datapoint}',
        });
        assert.equal(config.topicStatus, '${prefix}/status/${room}/${channelName}/${datapoint}');
        assert.equal(config.topicSet, '${prefix}/set/${room}/${channelName}/${datapoint}');
        assert.deepEqual(config.$deprecated, ['itemTemplate']);
    });

    test('without the old options nothing is touched', () => {
        const config = applyItemTemplates({topicStatus: 'x/${datapoint}', topicSet: 'y/${datapoint}'});
        assert.equal(config.topicStatus, 'x/${datapoint}');
        assert.equal(config.$deprecated, undefined);
    });
});
