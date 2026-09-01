import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {applyItemTemplates, DEFAULT_TOPIC_STATUS, DEFAULT_TOPIC_SET} from '../lib/topics.js';

describe('item template migration', () => {
    test('an item template becomes the pair of topic templates it used to mean', () => {
        const config = applyItemTemplates({
            itemTemplate: '${room}/${channelName}/${datapoint}',
            topicStatus: DEFAULT_TOPIC_STATUS,
            topicSet: DEFAULT_TOPIC_SET,
        });
        assert.equal(config.topicStatus, '${prefix}/status/${room}/${channelName}/${datapoint}');
        assert.equal(config.topicSet, '${prefix}/set/${room}/${channelName}/${datapoint}');
        assert.equal(config.$warnings.length, 1);
        assert.match(config.$warnings[0], /--item-template is deprecated/);
    });

    test('a topic template the user changed wins over the deprecated option', () => {
        const config = applyItemTemplates({
            itemTemplate: '${device}/${datapoint}',
            topicStatus: 'haus/${channelName}/state',
            topicSet: DEFAULT_TOPIC_SET,
        });
        assert.equal(config.topicStatus, 'haus/${channelName}/state');
        assert.equal(config.topicSet, DEFAULT_TOPIC_SET);
        assert.match(config.$warnings[0], /ignored here because --topic-status is set/);
    });

    test('without the old options nothing is touched', () => {
        const config = applyItemTemplates({topicStatus: 'x/${datapoint}', topicSet: 'y/${datapoint}'});
        assert.equal(config.topicStatus, 'x/${datapoint}');
        assert.equal(config.$warnings, undefined);
    });
});
